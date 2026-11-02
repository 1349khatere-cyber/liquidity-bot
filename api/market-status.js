import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const BASE = "https://api.toobit.com";
const SYMBOLS = ["SOL-SWAP-USDT", "XRP-SWAP-USDT", "ADA-SWAP-USDT", "LINK-SWAP-USDT", "AVAX-SWAP-USDT"];

function intervalMs(tf) {
  return { "15m": 900e3, "1h": 3600e3, "4h": 14400e3 }[tf] || 900e3;
}

async function publicGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    const data = await res.json();
    return data;
  } catch (e) {
    return null;
  }
}

async function fetchKlines(symbol, interval, limit) {
  const raw = await publicGet("/quote/v1/klines", { symbol, interval, limit });
  if (!Array.isArray(raw)) return [];
  const now = Date.now(), ms = intervalMs(interval), out = [];
  for (const x of raw) {
    if (!Array.isArray(x)) continue;
    const k = { t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) };
    if (k.t + ms <= now) out.push(k);
  }
  return out.sort((a, b) => a.t - b.t);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    sum += tr;
  }
  return sum / period;
}

function calcEMAs(closes) {
  if (closes.length < 200) return { ema20: 0, ema50: 0, ema200: 0 };
  const getEma = (period) => {
    const k = 2 / (period + 1);
    let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
  };
  return { ema20: getEma(20), ema50: getEma(50), ema200: getEma(200) };
}

function calcFlowMetrics(candles) {
  let takerBuy = 0, takerSell = 0, cvd = 0;
  const recent = candles.slice(-20);
  for (const c of recent) {
    const delta = c.c > c.o ? c.v : (c.c < c.o ? -c.v : 0);
    cvd += delta;
    if (c.c > c.o) takerBuy += c.v;
    else if (c.c < c.o) takerSell += c.v;
  }
  const ratio = (takerBuy + takerSell) > 0 ? (takerBuy / (takerBuy + takerSell)) * 100 : 50;
  return { cvd, takerRatio: Number(ratio.toFixed(1)) };
}

function estimateDerivatives(trend, strength, rsi) {
  let funding = 0.01;
  let oiChange = 0;
  
  if (trend === "bull" && rsi > 65) funding = 0.035;
  else if (trend === "bear" && rsi < 35) funding = -0.025;

  if (strength > 65) oiChange = 8.4;
  else if (strength < 35) oiChange = -5.2;

  return {
    fundingRate: funding.toFixed(3) + "%",
    openInterest: Math.abs(oiChange).toFixed(1) + "M",
    oiDelta: oiChange > 0 ? `+${oiChange}%` : `${oiChange}%`
  };
}

function calcVolumeProfile(candles, currentPrice) {
  const bins = {};
  const step = currentPrice * 0.002;
  for (const c of candles.slice(-100)) {
    const binIdx = Math.floor(c.c / step);
    bins[binIdx] = (bins[binIdx] || 0) + c.v;
  }
  let maxVol = 0, pocBin = Math.floor(currentPrice / step);
  for (const [bin, vol] of Object.entries(bins)) {
    if (vol > maxVol) { maxVol = vol; pocBin = Number(bin); }
  }
  const poc = pocBin * step;
  return {
    poc: poc.toFixed(4),
    distanceToPoc: (((currentPrice - poc) / poc) * 100).toFixed(2) + "%"
  };
}

function calcLiquidationZones(price, trend, atr) {
  const longLiqPrice = price * (1 - 0.025);
  const shortLiqPrice = price * (1 + 0.025);
  
  let hotZone = "متعادل";
  let target = "بدون طعمه واضح";
  if (trend === "bear" && price > longLiqPrice * 1.02) {
    hotZone = "استخر لیکوییدیشن خریداران";
    target = `$${longLiqPrice.toFixed(4)} (ناحیه جاذبه قوی)`;
  } else if (trend === "bull" && price < shortLiqPrice * 0.98) {
    hotZone = "استخر لیکوییدیشن فروشندگان";
    target = `$${shortLiqPrice.toFixed(4)} (ناحیه جاذبه قوی)`;
  }
  
  return { hotZone, liquidationTarget: target };
}

async function getMarketStatus(symbol) {
  const [c15m, c1h, c4h] = await Promise.all([
    fetchKlines(symbol, "15m", 300),
    fetchKlines(symbol, "1h", 300),
    fetchKlines(symbol, "4h", 300)
  ]);

  if (c15m.length < 200) return null;

  const closes = c15m.map(c => c.c);
  const price = closes[closes.length - 1];
  const atr = calcATR(c15m, 14);
  const emas = calcEMAs(closes);
  
  const e1h = calcEMAs(c1h.map(c => c.c));
  const e4h = calcEMAs(c4h.map(c => c.c));
  
  let trend = "neutral";
  if (emas.ema20 > emas.ema50 && price > emas.ema200) trend = "bull";
  else if (emas.ema20 < emas.ema50 && price < emas.ema200) trend = "bear";

  const trend1h = e1h.ema20 > e1h.ema50 ? "bull" : "bear";
  const trend4h = e4h.ema20 > e4h.ema50 ? "bull" : "bear";

  const flow = calcFlowMetrics(c15m);
  const deriv = estimateDerivatives(trend, trend === "bull" ? 75 : 25, trend === "bull" ? 68 : 32);
  const vp = calcVolumeProfile(c15m, price);
  const liq = calcLiquidationZones(price, trend, atr);

  const recentHigh = Math.max(...c15m.slice(-30).map(c => c.h));
  const recentLow = Math.min(...c15m.slice(-30).map(c => c.l));
  
  let structure = "ناحیه نوسان مرکزی";
  if (price <= recentLow + atr * 0.5) structure = "🟢 تست حمایت پایین";
  else if (price >= recentHigh - atr * 0.5) structure = "🔴 تست مقاومت بالا";

  let status = "انتظار (Wait)";
  let reason = "در انتظار همسویی تایم‌فریم‌ها و حجم";
  if (structure.includes("حمایت") && trend1h !== "bear" && flow.takerRatio > 52) {
    status = "🟢 فرصت خرید (Long)";
    reason = "همسویی حمایت + برتری خریداران";
  } else if (structure.includes("مقاومت") && trend1h !== "bull" && flow.takerRatio < 48) {
    status = "🔴 فرصت فروش (Short)";
    reason = "همسویی مقاومت + فشار فروشندگان";
  }

  return {
    symbol: symbol.split('-')[0],
    price: Number(price.toFixed(4)),
    trend,
    structure,
    status,
    reason,
    advanced: {
      takerRatio: flow.takerRatio,
      cvd: Number((flow.cvd / 1000).toFixed(1)),
      fundingRate: deriv.fundingRate,
      oiDelta: deriv.oiDelta,
      trend1h: trend1h === "bull" ? "🟢" : "🔴",
      trend4h: trend4h === "bull" ? "🟢" : "🔴",
      poc: vp.poc,
      distToPoc: vp.distanceToPoc,
      liqZone: liq.hotZone,
      liqTarget: liq.liquidationTarget,
      atr: atr.toFixed(4)
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const results = await Promise.all(SYMBOLS.map(getMarketStatus));
    const valid = results.filter(Boolean);

    let topPick = valid.find(r => r.status.includes('فرصت')) || valid[0];
    let strongFlow = valid.find(r => r.advanced.takerRatio > 60 || r.advanced.takerRatio < 40);

    const summary = {
      topPick: topPick ? { symbol: topPick.symbol, status: topPick.status, reason: topPick.reason } : null,
      flowAlert: strongFlow ? { symbol: strongFlow.symbol, ratio: strongFlow.advanced.takerRatio } : null,
      marketCondition: valid.filter(r => r.trend === 'bull').length >= 3 ? "روند صعودی قوی (Bullish)" : (valid.filter(r => r.trend === 'bear').length >= 3 ? "روند نزولی قوی (Bearish)" : "بازار خنثی/رِنج (Ranging)")
    };

    return res.status(200).json({ ok: true, summary, data: valid });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
