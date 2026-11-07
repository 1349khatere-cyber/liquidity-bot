// lib/engine2.js
// Engine 2 — Pivot Support/Resistance + MACD Arrow (TSR Logic)
// v4.0.0 — Upgraded to find real Pivots (highs/lows) and confirm with MACD.

export const ENGINE2_VERSION = "4.0.0 (Pivot S/R + MACD)";

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

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

// تابع پیدا کردن سقف و کف‌های واقعی (ترجمه شده از اندیکاتور TSR)
function getPivots(candles, leftBars = 5, rightBars = 5) {
  const highs = [];
  const lows = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isHigh = true;
    let isLow = true;
    
    // چک کردن سمت چپ
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i].h <= candles[i - j].h) isHigh = false;
      if (candles[i].l >= candles[i - j].l) isLow = false;
    }
    // چک کردن سمت راست
    for (let j = 1; j <= rightBars; j++) {
      if (candles[i].h <= candles[i + j].h) isHigh = false;
      if (candles[i].l >= candles[i + j].l) isLow = false;
    }
    
    if (isHigh) highs.push({ price: candles[i].h, index: i, time: candles[i].t });
    if (isLow) lows.push({ price: candles[i].l, index: i, time: candles[i].t });
  }
  return { highs, lows };
}

export function detectSignalEngine2(symbol, timeframe, candles) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles) || candles.length < 100) return null;

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  
  const { hist } = calcMACD(closes);
  if (hist.length < 2) return null;
  const currentHist = hist[hist.length - 1] || 0;
  const prevHist = hist[hist.length - 2] || 0;

  const atrVal = calcATR(candles, 14);
  if (!(atrVal > 0)) return null;

  // پیدا کردن آخرین سقف (مقاومت) و کف (حمایت)
  const pivots = getPivots(candles, 5, 5);
  const lastHigh = pivots.highs.length > 0 ? pivots.highs[pivots.highs.length - 1] : null;
  const lastLow = pivots.lows.length > 0 ? pivots.lows[pivots.lows.length - 1] : null;

  let side = null;
  let reason = "";

  // حساسیت برخورد با سقف و کف (اگر قیمت در محدوده 0.5 درصدی سقف یا کف باشد)
  const tolerance = 0.005;

  const isNearResistance = lastHigh && Math.abs(price - lastHigh.price) / lastHigh.price < tolerance;
  const isNearSupport = lastLow && Math.abs(price - lastLow.price) / lastLow.price < tolerance;

  // شرط سیگنال خرید (فلش سبز): قیمت نزدیک کف است + MACD صعودی + روند صعودی
  const isBullishTrend = ema9 > ema21;
  const isMacdBullish = currentHist > 0; 
  
  if (isNearSupport && isBullishTrend && isMacdBullish) {
    side = "LONG";
    reason = `5m: برخورد با کف (Support) در ${lastLow.price.toFixed(4)} + تایید MACD صعودی.`;
  }

  // شرط سیگنال فروش (فلش قرمز): قیمت نزدیک سقف است + MACD نزولی + روند نزولی
  const isBearishTrend = ema9 < ema21;
  const isMacdBearish = currentHist < 0;
  
  if (isNearResistance && isBearishTrend && isMacdBearish) {
    side = "SHORT";
    reason = `5m: برخورد با سقف (Resistance) در ${lastHigh.price.toFixed(4)} + تایید MACD نزولی.`;
  }

  // اگر هنوز سیگنالی پیدا نشده، یک حالت اضافه برای شکست مقاومت (Breakout) با MACD
  if (!side) {
    if (lastHigh && price > lastHigh.price && isMacdBullish && prevHist < currentHist) {
        side = "LONG";
        reason = `5m: شکست سقف قبلی (${lastHigh.price.toFixed(4)}) + شتاب MACD.`;
    } else if (lastLow && price < lastLow.price && isMacdBearish && prevHist > currentHist) {
        side = "SHORT";
        reason = `5m: شکست کف قبلی (${lastLow.price.toFixed(4)}) + شتاب MACD.`;
    }
  }

  if (!side) return null;

  const slDist = atrVal * 1.5;
  const tpDist = slDist * 2.0;

  const entry = price;
  const sl = side === "LONG" ? entry - slDist : entry + slDist;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  return {
    engine: "ENGINE_2_PIVOT_MACD",
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
    candleTime: candles[candles.length - 1].t,
    timestamp: Date.now()
  };
}
