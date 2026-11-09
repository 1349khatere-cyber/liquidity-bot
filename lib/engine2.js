// lib/engine2.js
// Engine 2 — Multi-Timeframe (5m SMC/Regression + 1m EMA9)
// v8.5.0 — Integrated FVG, Order Blocks, Linear Regression Channel, and Patterns.

export const ENGINE2_VERSION = "8.5.0 (SMC + Regression Channel)";

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c)));
  }
  let v = 0; for (let i = 0; i < period; i++) v += trs[i]; v /= period;
  for (let i = period; i < trs.length; i++) v = (v * (period - 1) + trs[i]) / period;
  return v;
}

function getPivots(candles, length = 20) {
  const highs = []; const lows = [];
  for (let i = length; i < candles.length - length; i++) {
    let isHigh = true; let isLow = true;
    for (let j = 1; j <= length; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isHigh = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isLow = false;
    }
    if (isHigh) highs.push({ price: candles[i].h, index: i });
    if (isLow) lows.push({ price: candles[i].l, index: i });
  }
  return { highs, lows };
}

function getTrendlinePrice(p1, p2, currentIndex) {
  const m = (p2.price - p1.price) / (p2.index - p1.index);
  const b = p1.price - m * p1.index;
  return m * currentIndex + b;
}

// ==========================================
// ✅ توابع جدید SMC و کانال رگرسیون
// ==========================================
function checkFVGOrOB(candles, side) {
  const n = candles.length;
  if (n < 20) return false;
  const currentPrice = candles[n - 1].c;
  
  // 1. بررسی FVG (Fair Value Gap) در 15 کندل اخیر
  for (let i = n - 2; i > n - 15 && i > 2; i--) {
    // Bullish FVG: Low of candle > High of candle 2 bars ago
    if (side === "LONG" && candles[i].l > candles[i - 2].h) {
      const fvgTop = candles[i].l;
      const fvgBottom = candles[i - 2].h;
      if (currentPrice >= fvgBottom && currentPrice <= fvgTop) return true;
    }
    // Bearish FVG: High of candle < Low of candle 2 bars ago
    if (side === "SHORT" && candles[i].h < candles[i - 2].l) {
      const fvgTop = candles[i - 2].l;
      const fvgBottom = candles[i].h;
      if (currentPrice >= fvgBottom && currentPrice <= fvgTop) return true;
    }
  }

  // 2. بررسی Order Block در 15 کندل اخیر
  for (let i = n - 2; i > n - 15 && i > 1; i--) {
    // Bullish OB: Last down candle before a strong up move
    if (side === "LONG" && candles[i].c < candles[i].o && candles[i+1].c > candles[i+1].o && (candles[i+1].c - candles[i+1].o) > (candles[i].o - candles[i].c) * 1.5) {
      if (currentPrice >= candles[i].l && currentPrice <= candles[i].h) return true;
    }
    // Bearish OB: Last up candle before a strong down move
    if (side === "SHORT" && candles[i].c > candles[i].o && candles[i+1].c < candles[i+1].o && (candles[i+1].o - candles[i+1].c) > (candles[i].c - candles[i].o) * 1.5) {
      if (currentPrice >= candles[i].l && currentPrice <= candles[i].h) return true;
    }
  }
  return false;
}

function checkRegressionChannel(candles, side) {
  const n = candles.length;
  if (n < 50) return false;
  const length = 50;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < length; i++) {
    const y = candles[n - length + i].c;
    const x = i;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const slope = (length * sumXY - sumX * sumY) / (length * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / length;
  
  // Calculate standard deviation (simplified)
  let sumSqErr = 0;
  for (let i = 0; i < length; i++) {
    const predicted = slope * i + intercept;
    const actual = candles[n - length + i].c;
    sumSqErr += Math.pow(actual - predicted, 2);
  }
  const stdDev = Math.sqrt(sumSqErr / length);
  
  const currentReg = slope * (length - 1) + intercept;
  const upperBand = currentReg + stdDev * 2.0;
  const lowerBand = currentReg - stdDev * 2.0;
  
  const currentPrice = candles[n - 1].c;
  const tolerance = stdDev * 0.2;

  if (side === "LONG" && currentPrice <= lowerBand + tolerance) return true;
  if (side === "SHORT" && currentPrice >= upperBand - tolerance) return true;
  
  return false;
}

function isBullishRejection(c) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.c, c.o) - c.l;
  return c.c > c.o && (lowerWick >= range * 0.25 || body >= range * 0.45);
}

function isBearishRejection(c) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  const body = Math.abs(c.c - c.o);
  const upperWick = c.h - Math.max(c.c, c.o);
  return c.c < c.o && (upperWick >= range * 0.25 || body >= range * 0.45);
}

function isBullishEngulfing(candles) {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  return prev.c < prev.o && cur.c > cur.o && cur.c > prev.o && cur.o < prev.c;
}

function isBearishEngulfing(candles) {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  return prev.c > prev.o && cur.c < cur.o && cur.o > prev.c && cur.c < prev.o;
}

export function detectSignalEngine2(symbol, timeframe, candles5m, candles1m) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles5m) || candles5m.length < 100) return null;
  if (!Array.isArray(candles1m) || candles1m.length < 50) return null;

  const currentIdx5m = candles5m.length - 1;
  const last5m = candles5m[currentIdx5m];

  const atr5m = calcATR(candles5m, 14);
  if (!(atr5m > 0)) return null;

  const pivots5m = getPivots(candles5m, 20);
  let side = null;
  let reason = "";
  const tolerancePct = 0.006;

  // شرط‌های ورود (OR)
  // 1. برخورد با خطوط روند معمولی
  if (pivots5m.highs.length >= 2) {
    const p1 = pivots5m.highs[pivots5m.highs.length - 2];
    const p2 = pivots5m.highs[pivots5m.highs.length - 1];
    if (p1.price > p2.price) {
      const trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      if (trendPrice > 0 && Math.abs(last5m.h - trendPrice) / trendPrice < tolerancePct) {
        side = "SHORT"; reason = `Trendline Short`;
      }
    }
  }
  if (!side && pivots5m.lows.length >= 2) {
    const p1 = pivots5m.lows[pivots5m.lows.length - 2];
    const p2 = pivots5m.lows[pivots5m.lows.length - 1];
    if (p1.price < p2.price) {
      const trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      if (trendPrice > 0 && Math.abs(last5m.l - trendPrice) / trendPrice < tolerancePct) {
        side = "LONG"; reason = `Trendline Long`;
      }
    }
  }

  // 2. برخورد با FVG یا Order Block
  if (!side && checkFVGOrOB(candles5m, "LONG")) { side = "LONG"; reason = "FVG/OB Long"; }
  if (!side && checkFVGOrOB(candles5m, "SHORT")) { side = "SHORT"; reason = "FVG/OB Short"; }

  // 3. برخورد با کانال رگرسیون
  if (!side && checkRegressionChannel(candles5m, "LONG")) { side = "LONG"; reason = "Regression Channel Bottom"; }
  if (!side && checkRegressionChannel(candles5m, "SHORT")) { side = "SHORT"; reason = "Regression Channel Top"; }

  if (!side) return null;

  // تایید کندل برگشتی
  let hasValidPattern = false;
  if (side === "LONG") {
    if (isBullishRejection(last5m) || isBullishEngulfing(candles5m)) hasValidPattern = true;
  } else {
    if (isBearishRejection(last5m) || isBearishEngulfing(candles5m)) hasValidPattern = true;
  }
  if (!hasValidPattern) return null;
  reason += ` + Rejection Candle`;

  // تاییدیه 1 دقیقه
  const current1m = candles1m[candles1m.length - 1]; 
  const closes1m = candles1m.map(c => c.c);
  const ema9_1m = ema(closes1m, 9);

  if (side === "LONG" && current1m.c <= ema9_1m) return null; 
  if (side === "SHORT" && current1m.c >= ema9_1m) return null; 
  reason += ` + 1m EMA9`;

  const entry = current1m.c; 
  const slBuffer = atr5m * 0.8;
  const sl = side === "LONG" ? last5m.l - slBuffer : last5m.h + slBuffer;
  const slDist = Math.abs(entry - sl);

  if (slDist < atr5m * 0.5 || slDist > atr5m * 4.0) return null;

  const tpDist = slDist * 2.0;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  if (side === "LONG" && (sl >= entry || tp <= entry)) return null;
  if (side === "SHORT" && (sl <= entry || tp >= entry)) return null;

  const rr = tpDist / slDist;

  return {
    engine: "ENGINE_2_MTF_V8",
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp,
    slDist,
    tpDist,
    rr,
    reason,
    atr: atr5m,
    candleTime: last5m.t,
    timestamp: Date.now()
  };
}
