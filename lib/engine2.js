// lib/engine2.js
// Engine 2 — Relaxed Multi-Timeframe (5m TSR/SMC + 1m Entry)
// v8.6.1 — Increased SL Buffer to 1.2 * ATR (to avoid market noise).

export const ENGINE2_VERSION = "8.6.1 (Wider SL Buffer)";

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
// ✅ توابع ساده‌شده برای تشخیص سیگنال
// ==========================================
function checkFVGOrOB(candles, side) {
  const n = candles.length;
  if (n < 20) return false;
  const lastCandle = candles[n - 1];
  
  for (let i = n - 2; i > n - 15 && i > 2; i--) {
    // Bullish FVG
    if (side === "LONG" && candles[i].l > candles[i - 2].h) {
      const fvgTop = candles[i].l;
      const fvgBottom = candles[i - 2].h;
      if (lastCandle.l <= fvgTop && lastCandle.l >= fvgBottom) return true;
    }
    // Bearish FVG
    if (side === "SHORT" && candles[i].h < candles[i - 2].l) {
      const fvgTop = candles[i - 2].l;
      const fvgBottom = candles[i].h;
      if (lastCandle.h >= fvgBottom && lastCandle.h <= fvgTop) return true;
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
    sumX += i; sumY += y; sumXY += i * y; sumXX += i * i;
  }
  const slope = (length * sumXY - sumX * sumY) / (length * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / length;
  
  let sumSqErr = 0;
  for (let i = 0; i < length; i++) {
    const predicted = slope * i + intercept;
    sumSqErr += Math.pow(candles[n - length + i].c - predicted, 2);
  }
  const stdDev = Math.sqrt(sumSqErr / length);
  
  const currentReg = slope * (length - 1) + intercept;
  const upperBand = currentReg + stdDev * 2.0;
  const lowerBand = currentReg - stdDev * 2.0;
  
  const tolerance = stdDev * 0.8; 

  if (side === "LONG" && candles[n - 1].l <= lowerBand + tolerance) return true;
  if (side === "SHORT" && candles[n - 1].h >= upperBand - tolerance) return true;
  
  return false;
}

function isStrongCandle(c, side) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  const body = Math.abs(c.c - c.o);
  
  if (side === "LONG") {
    return (c.c > c.o && body >= range * 0.4) || (Math.min(c.c, c.o) - c.l) >= range * 0.5;
  } else {
    return (c.c < c.o && body >= range * 0.4) || (c.h - Math.max(c.c, c.o)) >= range * 0.5;
  }
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
  const tolerancePct = 0.008;

  // 1. Trendlines
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

  // 2. FVG / OB
  if (!side && checkFVGOrOB(candles5m, "LONG")) { side = "LONG"; reason = "FVG/OB Long"; }
  if (!side && checkFVGOrOB(candles5m, "SHORT")) { side = "SHORT"; reason = "FVG/OB Short"; }

  // 3. Regression Channel
  if (!side && checkRegressionChannel(candles5m, "LONG")) { side = "LONG"; reason = "Regression Bottom"; }
  if (!side && checkRegressionChannel(candles5m, "SHORT")) { side = "SHORT"; reason = "Regression Top"; }

  if (!side) return null;

  // بررسی الگوی کندلی ساده و قوی
  if (!isStrongCandle(last5m, side)) return null;
  reason += ` + Strong Candle`;

  // نقطه ورود از تایم 1 دقیقه
  const current1m = candles1m[candles1m.length - 1]; 
  const entry = current1m.c; 
  
  // ✅ تغییر جدید: افزایش بافر SL به 1.2 برابر ATR برای جلوگیری از نویز
  const slBuffer = atr5m * 1.2;
  const sl = side === "LONG" ? last5m.l - slBuffer : last5m.h + slBuffer;
  const slDist = Math.abs(entry - sl);

  if (slDist < atr5m * 0.5 || slDist > atr5m * 4.5) return null;

  const tpDist = slDist * 2.0;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  if (side === "LONG" && (sl >= entry || tp <= entry)) return null;
  if (side === "SHORT" && (sl <= entry || tp >= entry)) return null;

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
    rr: tpDist / slDist,
    reason,
    atr: atr5m,
    candleTime: last5m.t,
    timestamp: Date.now()
  };
}
