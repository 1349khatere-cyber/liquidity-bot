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

  const recentCandles = candles.slice(-30);
  const recentHigh = Math.max(...recentCandles.map(c => c.h));
  const recentLow = Math.min(...recentCandles.map(c => c.l));

  // منطق دقیق تشخیص ساختار و تایید کندلی
  let structure = "میانه رنج (در حال نوسان)";
  let status = "انتظار";
  let reason = "شرایط ایده‌آل نیست";
  let timeEstimate = "نامشخص";

  // بررسی وضعیت نزدیک حمایت
  if (price <= recentLow + (atr * 0.5)) {
      const isGreenCandle = currentCandle.c > currentCandle.o;
      const isBreaking = currentCandle.c < recentLow;

      if (isBreaking && !isGreenCandle) {
          structure = "🔴 شکست حمایت";
          status = "🔴 فروش (ادامه روند نزولی)";
          reason = "کندل نزولی زیر سطح حمایت بسته شده است";
          timeEstimate = "۲ تا ۴ کندل";
      } else if (!isBreaking && isGreenCandle) {
          structure = "🟢 برگشت از حمایت";
          status = "🟢 آماده خرید";
          reason = "کندل صعودی روی حمایت شکل گرفته است";
          timeEstimate = "۳ تا ۵ کندل";
      } else {
          structure = "⏳ تست حمایت (بدون تایید)";
          status = "انتظار برای تایید کندل";
          reason = "قیمت روی حمایت است اما کندل هنوز تاییدیه برگشت نداده است";
      }
  } 
  // بررسی وضعیت نزدیک مقاومت
  else if (price >= recentHigh - (atr * 0.5)) {
      const isRedCandle = currentCandle.c < currentCandle.o;
      const isBreaking = currentCandle.c > recentHigh;

      if (isBreaking && !isRedCandle) {
          structure = "🟢 شکست مقاومت";
          status = "🟢 خرید (ادامه روند صعودی)";
          reason = "کندل صعودی بالای سطح مقاومت بسته شده است";
          timeEstimate = "۲ تا ۴ کندل";
      } else if (!isBreaking && isRedCandle) {
          structure = "🔴 برگشت از مقاومت";
          status = "🔴 آماده فروش";
          reason = "کندل نزولی روی مقاومت شکل گرفته است";
          timeEstimate = "۳ تا ۵ کندل";
      } else {
          structure = "⏳ تست مقاومت (بدون تایید)";
          status = "انتظار برای تایید کندل";
          reason = "قیمت روی مقاومت است اما کندل هنوز تاییدیه رد شدن نداده است";
      }
  }

  let confirmation = "بدون تایید قوی";
  if (volRatio > 1.5 && Math.abs(currentCandle.c - currentCandle.o) > atr * 0.5) confirmation = "🟢 کندل قوی + حجم زیاد";
  else if (volRatio > 1.1) confirmation = "🟡 حجم متوسط";

  let trend = "neutral";
  if (ema20 > ema50 && price > ema200) trend = "bull";
  else if (ema20 < ema50 && price < ema200) trend = "bear";

  const aiConsensus = trend === "bull" ? "🟢 ۲/۳ خرید" : trend === "bear" ? "🔴 ۲/۳ فروش" : "⚪ خنثی";
  const whaleActivity = volRatio > 1.3 ? "🐋 فعالیت بالا" : "⚪ عادی";

  return { 
    symbol: symbol.split('-')[0], 
    price: Number(price.toFixed(4)), 
    trend, 
    structure, 
    confirmation, 
    rsi: Number.isFinite(rsiVal) ? Number(rsiVal.toFixed(1)) : 0, 
    aiConsensus, 
    whaleActivity, 
    status, 
    timeEstimate, 
    reason 
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const results = await Promise.all(SYMBOLS.map(getMarketStatus));
    return res.status(200).json({ ok: true, data: results.filter(Boolean) });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message }); }
}
