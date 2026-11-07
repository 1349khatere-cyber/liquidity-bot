// lib/engine2.js
// Engine 2 — TSR (Trendlines & Pivots) + MACD + Reversal Patterns (Candle Close)
// v5.0.0 — Requires a closed reversal candle at S/R levels + MACD momentum.

export const ENGINE2_VERSION = "5.0.0 (TSR + Candle Reversal + MACD)";

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return [];
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [e];
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function calcMACD(closes) {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const len = Math.min(e12.length, e26.length);
  if (len === 0) return { macdLine: [], signalLine: [], hist: [] };
  const macdLine = [];
  for (let i = 0; i < len; i++) macdLine.push(e12[i] - e26[i]);
  const signalLine = emaSeries(macdLine, 9);
  const hist = [];
  for (let i = 0; i < signalLine.length; i++) {
    hist.push(macdLine[i + (macdLine.length - signalLine.length)] - signalLine[i]);
  }
  return { macdLine, signalLine, hist };
}

function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }
  let v = 0;
  for (let i = 0; i < period; i++) v += trs[i];
  v /= period;
  for (let i = period; i < trs.length; i++) v = (v * (period - 1) + trs[i]) / period;
  return v;
}

// پیدا کردن پیوت‌ها (سقف و کف) دقیقاً مثل ta.pivothigh(20, 20)
function getPivots(candles, length = 20) {
  const highs = [];
  const lows = [];
  
  for (let i = length; i < candles.length - length; i++) {
    let isHigh = true;
    let isLow = true;
    
    for (let j = 1; j <= length; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isHigh = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isLow = false;
    }
    
    if (isHigh) highs.push({ price: candles[i].h, index: i });
    if (isLow) lows.push({ price: candles[i].l, index: i });
  }
  return { highs, lows };
}

// محاسبه قیمت روی خط روند در ایندکس فعلی
function getTrendlinePrice(p1, p2, currentIndex) {
  const m = (p2.price - p1.price) / (p2.index - p1.index);
  const b = p1.price - m * p1.index;
  return m * currentIndex + b;
}

// تشخیص الگوی کندلی برگشتی نزولی (برای سیگنال فروش)
function isBearishReversal(candle) {
  if (!candle) return false;
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  const body = Math.abs(candle.c - candle.o);
  const upperWick = candle.h - Math.max(candle.c, candle.o);
  const lowerWick = Math.min(candle.c, candle.o) - candle.l;
  
  // 1. Shooting Star / Pinbar
  if (upperWick > range * 0.6 && body < range * 0.35) return true;
  // 2. Strong Bearish Candle (Engulfing or Marubozu)
  if (candle.c < candle.o && body > range * 0.5 && upperWick < range * 0.3) return true;
  
  return false;
}

// تشخیص الگوی کندلی برگشتی صعودی (برای سیگنال خرید)
function isBullishReversal(candle) {
  if (!candle) return false;
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  const body = Math.abs(candle.c - candle.o);
  const upperWick = candle.h - Math.max(candle.c, candle.o);
  const lowerWick = Math.min(candle.c, candle.o) - candle.l;
  
  // 1. Hammer / Pinbar
  if (lowerWick > range * 0.6 && body < range * 0.35) return true;
  // 2. Strong Bullish Candle (Engulfing or Marubozu)
  if (candle.c > candle.o && body > range * 0.5 && lowerWick < range * 0.3) return true;
  
  return false;
}

export function detectSignalEngine2(symbol, timeframe, candles) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles) || candles.length < 100) return null;

  // ❗️ ۱. فقط روی کندل‌های بسته شده کار می‌کنیم (کندل آخر حذف می‌شود)
  const closedCandles = candles.slice(0, -1);
  const currentIndex = closedCandles.length - 1;
  const lastCandle = closedCandles[currentIndex]; // کندل بسته شده اخیر
  
  const closes = closedCandles.map(c => c.c);
  const price = lastCandle.c; // قیمت بسته شدن

  const { hist } = calcMACD(closes);
  if (hist.length < 2) return null;
  const currentHist = hist[hist.length - 1] || 0;
  const prevHist = hist[hist.length - 2] || 0;

  const atrVal = calcATR(closedCandles, 14);
  if (!(atrVal > 0)) return null;

  const pivots = getPivots(closedCandles, 20);
  let side = null;
  let reason = "";

  const tolerancePct = 0.003; // حساسیت برخورد (0.3%)

  // 🛑 ۲. بررسی سیگنال فروش (SHORT) در سقف
  if (pivots.highs.length >= 2) {
    const p1 = pivots.highs[pivots.highs.length - 2];
    const p2 = pivots.highs[pivots.highs.length - 1];
    
    // خط روند نزولی شیب‌دار یا مقاومت افقی
    if (p1.price > p2.price && p2.index - p1.index > 2) { 
      const trendPrice = getTrendlinePrice(p1, p2, currentIndex);
      
      // شرایط: برخورد با خط روند + کندل نزولی (برگشتی) + مومنتوم منفی رو به افزایش MACD
      if (Math.abs(lastCandle.h - trendPrice) / trendPrice < tolerancePct && 
          isBearishReversal(lastCandle) && 
          currentHist < 0 && currentHist < prevHist) {
        
        side = "SHORT";
        reason = `5m: برخورد با خط روند نزولی (${trendPrice.toFixed(4)}) + کندل برگشتی نزولی + شتاب MACD.`;
      }
    }
  }

  // 🟢 ۳. بررسی سیگنال خرید (LONG) در کف (اگر سیگنال فروش صادر نشده باشد)
  if (!side && pivots.lows.length >= 2) {
    const p1 = pivots.lows[pivots.lows.length - 2];
    const p2 = pivots.lows[pivots.lows.length - 1];
    
    // خط روند صعودی شیب‌دار یا حمایت افقی
    if (p1.price < p2.price && p2.index - p1.index > 2) { 
      const trendPrice = getTrendlinePrice(p1, p2, currentIndex);
      
      // شرایط: برخورد با خط روند + کندل صعودی (برگشتی) + مومنتوم مثبت رو به افزایش MACD
      if (Math.abs(lastCandle.l - trendPrice) / trendPrice < tolerancePct && 
          isBullishReversal(lastCandle) && 
          currentHist > 0 && currentHist > prevHist) {
        
        side = "LONG";
        reason = `5m: برخورد با خط روند صعودی (${trendPrice.toFixed(4)}) + کندل برگشتی صعودی + شتاب MACD.`;
      }
    }
  }

  if (!side) return null;

  const slDist = atrVal * 1.5;
  const tpDist = slDist * 2.0;

  const entry = price; // ورود در قیمت بسته شدن کندل تایید
  const sl = side === "LONG" ? entry - slDist : entry + slDist;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  return {
    engine: "ENGINE_2_TSR_V5",
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp,
    slDist,
    tpDist,
    rr: 2.0,
    reason,
    atr: atrVal,
    candleTime: lastCandle.t, // زمان کندل تایید شده
    timestamp: Date.now()
  };
}
