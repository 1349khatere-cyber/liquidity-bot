// lib/engine2.js
// Engine 2 — MTF Channel Bounce + 1m Entry + 15m Filter
// v8.6.7 — Fixed Channel Touch (using Wick) & Relaxed 1m Trigger.

export const ENGINE2_VERSION = "8.6.7 (Fixed MTF Channel Bounce)";

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
  
  return { upperBand, lowerBand, stdDev, slope };
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

export function detectSignalEngine2(symbol, timeframe, candles5m, candles1m, candles15m) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles5m) || candles5m.length < 100) return null;
  if (!Array.isArray(candles1m) || candles1m.length < 50) return null;
  if (!Array.isArray(candles15m) || candles15m.length < 50) return null;

  const last5m = candles5m[candles5m.length - 1];
  const atr5m = calcATR(candles5m, 14);
  if (!(atr5m > 0)) return null;

  // ۱. بررسی کانال 5 دقیقه (روند و موقعیت)
  const ch5m = getRegressionData(candles5m, 50);
  if (!ch5m) return null;
  
  const isDowntrend5m = ch5m.slope < -0.00001;
  const isUptrend5m = ch5m.slope > 0.00001;
  const tol5m = ch5m.stdDev * 0.5;
  
  // ✅ اصلاح: بررسی برخورد با سایه (High/Low) نه قیمت بسته شدن
  const atTop5m = last5m.h >= ch5m.upperBand - tol5m;
  const atBottom5m = last5m.l <= ch5m.lowerBand + tol5m;

  let side = null;
  let reason = "";

  // فقط در کانال نزولی شورت، و فقط در کانال صعودی لانگ
  if (isDowntrend5m && atTop5m) { side = "SHORT"; reason = "5m Channel Top (Downtrend)"; }
  if (isUptrend5m && atBottom5m) { side = "LONG"; reason = "5m Channel Bottom (Uptrend)"; }

  if (!side) return null;

  // ۲. تاییدیه کندل برگشتی در 5 دقیقه
  if (side === "LONG" && !isBullishRejection(last5m)) return null;
  if (side === "SHORT" && !isBearishRejection(last5m)) return null;
  reason += ` + 5m Rejection`;

  // ۳. فیلتر 15 دقیقه (فقط در جهت مخالف کف/سقف نباشیم)
  const ch15m = getRegressionData(candles15m, 50);
  if (ch15m) {
    const last15m = candles15m[candles15m.length - 1];
    const tol15m = ch15m.stdDev * 0.5;
    
    // ✅ اصلاح: بررسی سایه‌ها در 15 دقیقه
    const atBottom15m = last15m.l <= ch15m.lowerBand + tol15m;
    const atTop15m = last15m.h >= ch15m.upperBand - tol15m;

    if (side === "SHORT" && atBottom15m) return null;
    if (side === "LONG" && atTop15m) return null;
    reason += ` + 15m OK`;
  }

  // ۴. نقطه ورود دقیق از 1 دقیقه
  const current1m = candles1m[candles1m.length - 1];
  
  // ✅ اصلاح: تریگر 1 دقیقه ریلکس‌تر شد. 
  // فقط نیاز به یک کندل برگشتی یا کندل مومنتوم در جهت معامله داریم.
  if (side === "LONG") {
    if (!isBullishRejection(current1m) && !(current1m.c > current1m.o)) return null; 
  } else {
    if (!isBearishRejection(current1m) && !(current1m.c < current1m.o)) return null;
  }
  reason += ` + 1m Trigger`;

  // ۵. محاسبه TP/SL بر اساس 5 دقیقه
  const entry = current1m.c;
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
    rr: 2.0,
    reason,
    atr: atr5m,
    candleTime: last5m.t,
    timestamp: Date.now()
  };
}
