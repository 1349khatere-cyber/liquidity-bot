// lib/engine2.js
// Engine 2 — Relaxed MTF + 5m/15m Channel Logic
// v8.6.4 — Added 15m filter, 5m channel entry, 1m trigger, BOS confirmation.

export const ENGINE2_VERSION = "8.6.4 (3-TF Channel & BOS)";

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

// ==========================================
// ✅ توابع کانال رگرسیون
// ==========================================
function getRegressionData(candles, length = 50) {
  const n = candles.length;
  if (n < length) return null;
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
  
  return { upperBand, lowerBand, stdDev, slope, currentReg };
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

  const n = candles5m.length;
  const last5m = candles5m[n - 1];

  const atr5m = calcATR(candles5m, 14);
  if (!(atr5m > 0)) return null;

  // 1. بررسی کانال 5 دقیقه
  const channel5m = getRegressionData(candles5m, 50);
  if (!channel5m) return null;

  const currentPrice = last5m.c;
  const tolerance = channel5m.stdDev * 0.5;

  const atTop5m = currentPrice >= channel5m.upperBand - tolerance;
  const atBottom5m = currentPrice <= channel5m.lowerBand + tolerance;

  if (!atTop5m && !atBottom5m) return null;

  let side = atTop5m ? "SHORT" : "LONG";
  let reason = atTop5m ? "5m Channel Top" : "5m Channel Bottom";

  // 2. تاییدیه الگوی کندلی
  if (!isStrongCandle(last5m, side)) return null;
  reason += ` + Strong Candle`;

  // 3. بررسی BOS (شکست ساختار) در 5 دقیقه
  const pivots = getPivots(candles5m.slice(-20), 3);
  if (side === "SHORT" && pivots.lows.length > 0) {
    const lastLow = pivots.lows[pivots.lows.length - 1].price;
    if (currentPrice > lastLow) return null; // برای فروش باید کف را بشکند
  }
  if (side === "LONG" && pivots.highs.length > 0) {
    const lastHigh = pivots.highs[pivots.highs.length - 1].price;
    if (currentPrice < lastHigh) return null; // برای خرید باید سقف را بشکند
  }
  reason += ` + BOS`;

  // 4. ورود از 1 دقیقه
  const current1m = candles1m[candles1m.length - 1]; 
  const entry = current1m.c; 

  // 5. محاسبه TP/SL بر اساس ساختار 5 دقیقه
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

// برای فیلتر 15 دقیقه
export function check15mFilter(symbol, candles15m, side) {
  const channel15m = getRegressionData(candles15m, 50);
  if (!channel15m) return true; // اگر دیتا نبود، بلاک نکن
  const last15m = candles15m[candles15m.length - 1];
  const tolerance = channel15m.stdDev * 0.5;

  if (side === "SHORT" && last15m.c <= channel15m.lowerBand + tolerance) return false; // در کف 15m نرو شورت
  if (side === "LONG" && last15m.c >= channel15m.upperBand - tolerance) return false; // در سقف 15m نرو لانگ
  return true;
}
