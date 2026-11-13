// lib/engine2.js
// Engine 2 — Original User Strategy (MTF Channel & EMA50 Momentum)
// v10.0.0 — Removed strict R:R and slope thresholds to restore original logic.

export const ENGINE2_VERSION = "10.0.0 (Original Logic)";

// قفل جداگانه برای هر ارز جهت جلوگیری از سیگنال تکراری در یک کندل
const lastSignalMap = new Map();

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function adx(candles, period = 14) {
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n < period * 2 + 2) return NaN;
  const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) { 
    const up = candles[i].h - candles[i - 1].h; 
    const down = candles[i - 1].l - candles[i].l; 
    pdm[i] = (up > down && up > 0) ? up : 0; 
    mdm[i] = (down > up && down > 0) ? down : 0; 
    tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c)); 
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += pdm[i]; mS += mdm[i]; }
  const dx = [];
  const computeDx = () => { 
    if (trS === 0) return 0; 
    const pdi = 100 * pS / trS, mdi = 100 * mS / trS, s = pdi + mdi; 
    return s === 0 ? 0 : 100 * Math.abs(pdi - mdi) / s; 
  };
  dx.push(computeDx());
  for (let i = period + 1; i < n; i++) { 
    trS = trS - trS / period + tr[i]; 
    pS = pS - pS / period + pdm[i]; 
    mS = mS - mS / period + mdm[i]; 
    dx.push(computeDx()); 
  }
  if (dx.length < period) return dx.length ? dx[dx.length - 1] : NaN;
  let a = 0; 
  for (let i = 0; i < period; i++) a += dx[i]; 
  a /= period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
  return a;
}

// محاسبه کانال رگرسیون برای تایم 15 دقیقه (200 کندلی)
function getRegressionData(candles, length = 200) {
  const n = candles.length;
  if (n < length) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < length; i++) {
    const y = candles[n - length + i].c;
    sumX += i; sumY += y; sumXY += i * y; sumXX += i * i;
  }
  const denom = length * sumXX - sumX * sumX;
  if (denom === 0) return null; 
  
  const slope = (length * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / length;
  
  let sumSqErr = 0;
  for (let i = 0; i < length; i++) {
    const predicted = slope * i + intercept;
    sumSqErr += Math.pow(candles[n - length + i].c - predicted, 2);
  }
  const stdDev = Math.sqrt(sumSqErr / length);
  const currentReg = slope * (length - 1) + intercept;
  
  return { 
    slope,
    upper2_0: currentReg + stdDev * 2.0, 
    upper1_4: currentReg + stdDev * 1.4,
    lower1_4: currentReg - stdDev * 1.4,
    lower2_0: currentReg - stdDev * 2.0
  };
}

function isBullishRejection(c) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.c, c.o) - c.l;
  return c.c > c.o && (lowerWick >= range * 0.3 || body >= range * 0.5);
}

function isBearishRejection(c) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  const body = Math.abs(c.c - c.o);
  const upperWick = c.h - Math.max(c.c, c.o);
  return c.c < c.o && (upperWick >= range * 0.3 || body >= range * 0.5);
}

export function detectSignalEngine2(symbol, timeframe, candles5m, candles1m, candles15m) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles5m) || candles5m.length < 100) return null;
  if (!Array.isArray(candles1m) || candles1m.length < 50) return null;
  if (!Array.isArray(candles15m) || candles15m.length < 200) return null;

  const now = Date.now();
  const curr5m = candles5m[candles5m.length - 1];
  const prev5m = candles5m[candles5m.length - 2];
  const last1m = candles1m[candles1m.length - 1];
  
  // 0. بافر زمانی برای اطمینان از بسته شدن کندل‌ها (5 ثانیه تاخیر)
  if (curr5m.t + 300000 + 5000 > now || last1m.t + 60000 + 5000 > now) {
    return null; 
  }

  // 1. قفل سیگنال (بر اساس ارز و زمان کندل)
  const lastSigTime = lastSignalMap.get(symbol) || 0;
  if (curr5m.t === lastSigTime) {
    return null; 
  }

  // 2. بررسی رنج فشرده در تایم ۵ دقیقه (ADX >= 20)
  const adx5m = adx(candles5m, 14);
  if (!Number.isFinite(adx5m) || adx5m < 20) {
    return null; 
  }

  const ema50_5m = ema(candles5m.map(c => c.c), 50);

  // 3. فیلتر تایم ۱۵ دقیقه (بدون آستانه شیب، فقط جهت)
  const ch15m = getRegressionData(candles15m, 200);
  if (!ch15m) return null;

  const isUptrend15m = ch15m.slope > 0;
  const isDowntrend15m = ch15m.slope < 0;
  const ema50_15m = ema(candles15m.map(c => c.c), 50);
  const price15m = candles15m[candles15m.length - 1].c;

  // فیلتر 15m: در روند نزولی، محدوده بالای 1.4 تا 2.0 و بالای EMA50 ممنوع (خرید نکن)
  if (isDowntrend15m) {
    if (price15m >= ch15m.upper1_4 && price15m <= ch15m.upper2_0 && price15m > ema50_15m) {
      return null;
    }
  }
  // فیلتر 15m: در روند صعودی، محدوده پایین 2.0 تا 1.4 و زیر EMA50 ممنوع (فروش نکن)
  if (isUptrend15m) {
    if (price15m <= ch15m.lower1_4 && price15m >= ch15m.lower2_0 && price15m < ema50_15m) {
      return null;
    }
  }

  // 4. شرط ورود در تایم ۵ دقیقه (مومنتوم زیر/بالای EMA50)
  const isShort5m = prev5m.c < ema50_5m && curr5m.c < prev5m.c && curr5m.c < ema50_5m;
  const isLong5m = prev5m.c > ema50_5m && curr5m.c > prev5m.c && curr5m.c > ema50_5m;

  if (!isShort5m && !isLong5m) return null;

  // 5. بررسی دقیق گپ (Gap) در تایم ۱ دقیقه
  for (let i = candles1m.length - 5; i < candles1m.length; i++) {
    if (i > 0 && candles1m[i].t - candles1m[i - 1].t > 65000) {
      return null; 
    }
  }

  // 6. تریگر ۱ دقیقه
  let triggerLong = false;
  let triggerShort = false;

  if (isLong5m) {
    triggerLong = isBullishRejection(last1m);
  }
  if (isShort5m) {
    triggerShort = isBearishRejection(last1m);
  }

  if (!triggerLong && !triggerShort) return null;

  // 7. محاسبه SL و TP بر اساس کانال ۱۵ دقیقه (بدون فیلتر R:R)
  const entry = last1m.c;
  let sl, tp, side, reason;

  if (triggerLong) {
    side = "LONG";
    reason = "5m EMA50 Breakout + 15m Channel Filter + 1m Trigger";
    sl = ch15m.lower2_0;  
    tp = ch15m.upper1_4;  
    
    if (entry <= sl || tp <= entry) return null; 
  } else {
    side = "SHORT";
    reason = "5m EMA50 Breakdown + 15m Channel Filter + 1m Trigger";
    sl = ch15m.upper2_0;  
    tp = ch15m.lower1_4;  
    
    if (entry >= sl || tp >= entry) return null; 
  }

  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);

  // ثبت قفل سیگنال برای این ارز
  lastSignalMap.set(symbol, curr5m.t);

  return {
    engine: "ENGINE_2_MTF_V9",
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp,
    slDist,
    tpDist,
    rr: Number((tpDist / slDist).toFixed(2)),
    reason,
    atr: 0, // در این استراتژی استفاده نمی‌شود
    candleTime: curr5m.t,
    timestamp: Date.now()
  };
}
