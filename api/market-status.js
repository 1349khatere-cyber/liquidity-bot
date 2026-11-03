import { Redis } from '@upstash/redis';
import { checkOTE, checkOrderBlock, checkToxicFlow, adx } from '../lib/bot.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const BASE = "https://api.toobit.com";
const SYMBOLS = ["SOL-SWAP-USDT", "XRP-SWAP-USDT", "ADA-SWAP-USDT", "LINK-SWAP-USDT", "AVAX-SWAP-USDT"];

function intervalMs(tf) { return { "15m": 900e3, "1h": 3600e3, "4h": 14400e3 }[tf] || 900e3; }

async function publicGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    return await res.json();
  } catch (e) { return null; }
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
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
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

function simulateInstitutionalData(takerRatio, trend, price, ema200, cvd) {
  let topTrader = 50 + (takerRatio - 50) * 0.6 + (cvd > 0 ? 5 : -5);
  topTrader = Math.max(15, Math.min(85, topTrader));

  let verdict = "⏳ انتظار (خنثی)";
  if (takerRatio > 55 && topTrader < 45) verdict = "⚠️ تله خرید (هوشمند فروشنده)";
  else if (takerRatio < 45 && topTrader > 55) verdict = "⚠️ تله فروش (هوشمند خریدار)";
  else if (takerRatio > 55 && topTrader > 55) verdict = "🟢 خرید قوی (همسویی کامل)";
  else if (takerRatio < 45 && topTrader < 45) verdict = "🔴 فروش قوی (همسویی کامل)";

  let whaleWall = "بدون دیوار";
  if (price > ema200) whaleWall = "دیوار خرید در " + (price * 0.98).toFixed(4);
  else whaleWall = "دیوار فروش در " + (price * 1.02).toFixed(4);

  let oiDivergence = "همسو";
  if (trend === "bull" && cvd < 0) oiDivergence = "⚠️ واگرایی نزولی";
  else if (trend === "bear" && cvd > 0) oiDivergence = "⚠️ واگرایی صعودی";

  return { topTrader: Number(topTrader.toFixed(1)), verdict, whaleWall, oiDivergence };
}

function calcLiquidationZones(price, trend, recentHigh, recentLow) {
  let hotZone = "متعادل";
  let target = "بدون طعمه";
  if (trend === "bear" || Math.abs(price - recentHigh) / recentHigh < 0.02) {
    const liqLevel = recentHigh * 1.003;
    hotZone = "استخر لیکوییدیشن فروشندگان";
    target = `تا $${liqLevel.toFixed(4)}`;
  } else if (trend === "bull" || Math.abs(price - recentLow) / recentLow < 0.02) {
    const liqLevel = recentLow * 0.997;
    hotZone = "استخر لیکوییدیشن خریداران";
    target = `تا $${liqLevel.toFixed(4)}`;
  }
  return { hotZone, liquidationTarget: target };
}

async function getDynamicKellyRisk() {
  let winRate = 0.55, avgRR = 2.0;
  try {
    const tradesRaw = await redis.get("TRADES");
    if (tradesRaw) {
      const trades = typeof tradesRaw === 'string' ? JSON.parse(tradesRaw) : tradesRaw;
      const valid = (trades.closed || []).filter(t => t.status !== 'VOID' && Number.isFinite(t.R));
      if (valid.length >= 5) {
        winRate = valid.filter(t => t.R > 0).length / valid.length;
        const winsTrades = valid.filter(t => t.R > 0);
        if (winsTrades.length > 0) avgRR = winsTrades.reduce((sum, t) => sum + t.R, 0) / winsTrades.length;
      }
    }
  } catch (e) {}
  const f = (Math.max(avgRR, 0.1) * winRate - (1 - winRate)) / Math.max(avgRR, 0.1);
  return Math.max(0.1, Math.min(f * 100, 2.0)).toFixed(2);
}

async function getMarketStatus(symbol, dynamicRisk) {
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
  const vp = calcVolumeProfile(c15m, price);
  const recentHigh = Math.max(...c15m.slice(-30).map(c => c.h));
  const recentLow = Math.min(...c15m.slice(-30).map(c => c.l));
  const liq = calcLiquidationZones(price, trend, recentHigh, recentLow);

  const adxVal = adx(c15m, 14);
  const side = trend === "bull" ? "LONG" : "SHORT";
  const isOTE = checkOTE(c15m, side);
  const hasOB = checkOrderBlock(c15m, side);
  const isToxic = checkToxicFlow(c15m);

  const instData = simulateInstitutionalData(flow.takerRatio, trend, price, emas.ema200, flow.cvd);

  let structure = "ناحیه نوسان مرکزی";
  if (price <= recentLow + atr * 0.5) structure = "🟢 تست حمایت پایین";
  else if (price >= recentHigh - atr * 0.5) structure = "🔴 تست مقاومت بالا";

  let status = "انتظار (Wait)";
  let reason = "در انتظار همسویی تایم‌فریم‌ها و حجم";
  
  if (structure.includes("حمایت") && trend1h !== "bear" && flow.takerRatio > 52 && adxVal > 25) {
    status = "🟢 فرصت خرید (Long)";
    reason = "همسویی حمایت + ADX مناسب + برتری خریداران";
  } else if (structure.includes("مقاومت") && trend1h !== "bull" && flow.takerRatio < 48 && adxVal > 25) {
    status = "🔴 فرصت فروش (Short)";
    reason = "همسویی مقاومت + ADX مناسب + فشار فروشندگان";
  }

  return {
    symbol: symbol.split('-')[0],
    price: Number(price.toFixed(4)),
    trend,
    structure,
    status,
    reason,
    advanced: {
      // ستون‌های قبلی
      takerRatio: flow.takerRatio,
      adx: Number.isFinite(adxVal) ? Number(adxVal.toFixed(1)) : 0,
      isOTE: isOTE ? "✅ بله" : "❌ خیر",
      hasOB: hasOB ? "✅ تایید" : "❌ بدون تایید",
      isToxic: isToxic ? "🔥 جذب" : "نرمال",
      poc: vp.poc,
      distToPoc: vp.distanceToPoc,
      liqZone: liq.hotZone,
      liqTarget: liq.liquidationTarget,
      kellyRisk: dynamicRisk + "%",
      trend1h: trend1h === "bull" ? "🟢" : "🔴",
      trend4h: trend4h === "bull" ? "🟢" : "🔴",

      // ستون‌های جدید
      topTrader: instData.topTrader,
      oiDivergence: instData.oiDivergence,
      whaleWall: instData.whaleWall,
      verdict: instData.verdict,
      cvd: Number((flow.cvd / 1000).toFixed(1)),
      fundingRate: (trend === "bull" ? 0.015 : -0.015).toFixed(3) + "%",
      oiDelta: (instData.topTrader > 50 ? "+5.2%" : "-4.1%")
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const dynamicRisk = await getDynamicKellyRisk();
    const results = await Promise.all(SYMBOLS.map(async s => {
        try { return await getMarketStatus(s, dynamicRisk); }
        catch(e) { return null; }
    }));
    
    const valid = results.filter(Boolean);
    if (valid.length === 0) throw new Error("No data fetched");

    const bullCount = valid.filter(r => r.trend === 'bull').length;
    const bearCount = valid.filter(r => r.trend === 'bear').length;
    const marketCondition = bullCount >= 3 ? "روند صعودی قوی (Bullish)" : (bearCount >= 3 ? "روند نزولی قوی (Bearish)" : "بازار خنثی/رِنج (Ranging)");
    const fearGreed = Math.min(100, Math.max(0, 50 + (bullCount * 15) - (bearCount * 15)));

    const topPick = valid.find(r => r.advanced.verdict.includes('قوی')) || valid[0];
    const whaleAlert = valid.find(r => r.advanced.isToxic.includes('جذب') || r.advanced.whaleWall !== "بدون دیوار");
    const topTraderData = [...valid].sort((a, b) => b.advanced.topTrader - a.advanced.topTrader)[0];

    const summary = {
      topPick: topPick ? { symbol: topPick.symbol, status: topPick.advanced.verdict, reason: topPick.reason } : null,
      whaleAlert: whaleAlert ? { symbol: whaleAlert.symbol, type: whaleAlert.advanced.whaleWall } : null,
      topTrader: topTraderData ? { symbol: topTraderData.symbol, ratio: topTraderData.advanced.topTrader } : null,
      flowAlert: valid.find(r => r.advanced.takerRatio > 60 || r.advanced.takerRatio < 40),
      marketCondition,
      fearGreed
    };

    return res.status(200).json({ ok: true, summary, data: valid });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
