// api/market-status.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const BASE = "https://api.toobit.com";
const SYMBOLS = ["SOL-SWAP-USDT", "XRP-SWAP-USDT", "ADA-SWAP-USDT", "LINK-SWAP-USDT", "AVAX-SWAP-USDT"];
const INTERVAL = "15m";
const LIMIT = 300;

function intervalMs(tf) { return { "15m": 900e3 }[tf] || 900e3; }

async function fetchKlines(symbol, interval, limit) {
  const url = new URL(BASE + "/quote/v1/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", limit);
  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const raw = await res.json();
  const now = Date.now(); const ms = intervalMs(interval);
  const out = [];
  for (const x of raw) {
    if (!Array.isArray(x)) continue;
    const k = { t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) };
    if (k.t + ms <= now) out.push(k);
  }
  out.sort((a, b) => a.t - b.t); return out;
}

function ema(values, period) {
  if (values.length < period) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return NaN;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  const calc = () => avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  let r = calc();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period; avgLoss = (avgLoss * (period - 1) + l) / period; r = calc();
  }
  return r;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
  }
  return sum / period;
}

// شبیه‌سازی CVD (Cumulative Volume Delta)
function calcCVD(candles) {
  let cvd = 0;
  const cvdSeries = [];
  for (const c of candles) {
    const delta = c.c > c.o ? c.v : (c.c < c.o ? -c.v : 0);
    cvd += delta;
    cvdSeries.push(cvd);
  }
  return cvdSeries;
}

async function getMarketStatus(symbol) {
  const candles = await fetchKlines(symbol, INTERVAL, LIMIT);
  if (candles.length < 200) return null;

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  const currentCandle = candles[candles.length - 1];
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const rsiVal = rsi(closes, 14);
  const atr = calcATR(candles, 14);
  
  const vols = candles.map(c => c.v);
  const volMA20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volMA20 > 0 ? currentCandle.v / volMA20 : 1;

  // محاسبه جذب سفارشات (Absorption) و واگرایی (Divergence)
  const body = Math.abs(currentCandle.c - currentCandle.o);
  const range = currentCandle.h - currentCandle.l;
  let orderFlow = "نرمال";
  if (volRatio > 1.8 && body < range * 0.3) orderFlow = "🔴 جذب سفارشات"; // حجم بالا، بدنه کوچک
  else if (volRatio > 1.5) orderFlow = "🟢 جریان خرید/فروش قوی";

  const cvdSeries = calcCVD(candles);
  const recentCVD = cvdSeries[cvdSeries.length - 1] - cvdSeries[cvdSeries.length - 6];
  const recentPriceDiff = price - closes[closes.length - 6];
  let divergence = "همسو";
  if (recentPriceDiff > 0 && recentCVD < 0) divergence = "⚠️ واگرایی نزولی";
  else if (recentPriceDiff < 0 && recentCVD > 0) divergence = "⚠️ واگرایی صعودی";

  const recentCandles = candles.slice(-30);
  const recentHigh = Math.max(...recentCandles.map(c => c.h));
  const recentLow = Math.min(...recentCandles.map(c => c.l));

  let structure = "میانه رنج";
  let status = "انتظار";
  let reason = "شرایط ایده‌آل نیست";
  
  if (price <= recentLow + (atr * 0.5)) {
      const isGreenCandle = currentCandle.c > currentCandle.o;
      const isBreaking = currentCandle.c < recentLow;
      if (isBreaking && !isGreenCandle) { structure = "🔴 شکست حمایت"; status = "🔴 فروش"; reason = "شکست نزولی حمایت"; }
      else if (!isBreaking && isGreenCandle) { structure = "🟢 برگشت از حمایت"; status = "🟢 خرید"; reason = "تایید کندل صعودی روی حمایت"; }
      else { structure = "⏳ تست حمایت"; status = "انتظار"; reason = "در انتظار تایید کندل"; }
  } else if (price >= recentHigh - (atr * 0.5)) {
      const isRedCandle = currentCandle.c < currentCandle.o;
      const isBreaking = currentCandle.c > recentHigh;
      if (isBreaking && !isRedCandle) { structure = "🟢 شکست مقاومت"; status = "🟢 خرید"; reason = "شکست صعودی مقاومت"; }
      else if (!isBreaking && isRedCandle) { structure = "🔴 برگشت از مقاومت"; status = "🔴 فروش"; reason = "تایید کندل نزولی روی مقاومت"; }
      else { structure = "⏳ تست مقاومت"; status = "انتظار"; reason = "در انتظار تایید کندل"; }
  }

  let trend = "neutral";
  if (ema20 > ema50 && price > ema200) trend = "bull";
  else if (ema20 < ema50 && price < ema200) trend = "bear";

  // شاخص قدرت نسبی (0 تا 100)
  let strength = 50;
  if (trend === "bull") strength += 20;
  if (trend === "bear") strength -= 20;
  if (rsiVal > 60) strength += 10;
  if (rsiVal < 40) strength -= 10;
  if (volRatio > 1.5) strength += 10;
  strength = Math.max(0, Math.min(100, strength));

  return { 
    symbol: symbol.split('-')[0], 
    price: Number(price.toFixed(4)), 
    trend, 
    structure, 
    confirmation: orderFlow, 
    divergence,
    rsi: Number.isFinite(rsiVal) ? Number(rsiVal.toFixed(1)) : 0, 
    strength,
    status, 
    reason 
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const results = await Promise.all(SYMBOLS.map(getMarketStatus));
    const validResults = results.filter(Boolean);
    
    // ساخت خلاصه وضعیت (Summary)
    let topPick = validResults.find(r => r.status.includes('خرید') || r.status.includes('فروش')) || null;
    if (!topPick) topPick = validResults.sort((a, b) => b.strength - a.strength)[0]; // اگر هیچ کدام آماده نبود، قوی‌ترین را نشان بده

    const whaleAlert = validResults.find(r => r.confirmation.includes('جذب') || r.confirmation.includes('قوی'));
    
    let marketCondition = "رِنج (بدون روند)";
    const bullCount = validResults.filter(r => r.trend === 'bull').length;
    const bearCount = validResults.filter(r => r.trend === 'bear').length;
    if (bullCount >= 3) marketCondition = "صعودی (Bullish)";
    else if (bearCount >= 3) marketCondition = "نزولی (Bearish)";

    const summary = {
      topPick: topPick ? { symbol: topPick.symbol, status: topPick.status, reason: topPick.reason } : null,
      whaleAlert: whaleAlert ? { symbol: whaleAlert.symbol, type: whaleAlert.confirmation } : null,
      marketCondition
    };

    return res.status(200).json({ ok: true, summary, data: validResults });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message }); }
}
