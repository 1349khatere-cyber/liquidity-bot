// lib/engine2.js
// Engine 2 — MTF Channel & EMA50 Momentum
// v9.1.0 — Fixed technical issues: Strict 1m trigger, R:R validation, full 15m trend filter, real ATR, gap check.

export const ENGINE2_VERSION = "9.1.0 (Strict MTF Channel)";

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

// محاسبه کانال رگرسیون برای تایم 15 دقیقه
function getRegressionData(candles, length = 200) {
  const n = candles.length;
  if (n < length) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < length; i++) {
    const y = candles[n - length + i].c;
    sumX += i; sumY += y; sumXY += i * y; sumXX += i * i;
  }
  const denom = length * sumXX - sumX * sumX;
  if (denom === 0) return null; // جلوگیری از تقسیم بر صفر
  
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
  // کندل باید یا سایه پایینی بلند داشته باشد یا بدنه‌اش قوی باشد
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

  // ۱. بررسی رنج فشرده در تایم ۵ دقیقه
  const adx5m = adx(candles5m, 14);
  if (!Number.isFinite(adx5m) || adx5m < 20) {
    return null; 
  }

  const ema50_5m = ema(candles5m.map(c => c.c), 50);
  const prev5m = candles5m[candles5m.length - 2];
  const curr5m = candles5m[candles5m.length - 1];

  // ۲. فیلتر تایم ۱۵ دقیقه (روند کلان)
  const ch15m = getRegressionData(candles15m, 200);
  if (!ch15m) return null;

  const isUptrend15m = ch15m.slope > 0;
  const isDowntrend15m = ch15m.slope < 0;

  // ۳. شرط ورود در تایم ۵ دقیقه (بر اساس EMA 50 و مومنتوم)
  // فروش: روند 15 دقیقه نزولی + کندل 5 دقیقه زیر EMA50 + کندل فعلی زیر کندل قبلی
  const isShort5m = isDowntrend15m && prev5m.c < ema50_5m && curr5m.c < prev5m.c && curr5m.c < ema50_5m;
  
  // خرید: روند 15 دقیقه صعودی + کندل 5 دقیقه بالای EMA50 + کندل فعلی بالای کندل قبلی
  const isLong5m = isUptrend15m && prev5m.c > ema50_5m && curr5m.c > prev5m.c && curr5m.c > ema50_5m;

  if (!isShort5m && !isLong5m) return null;

  // ۴. تریگر ۱ دقیقه و بررسی گپ (فاصله زمانی)
  const last1m = candles1m[candles1m.length - 1];
  const prev1m = candles1m[candles1m.length - 2];
  
  // چک کردن ۵ کندل آخر برای گپ (فاصله بیشتر از 2 دقیقه = مشکل دیتا)
  for (let i = 1; i <= 5; i++) {
    if (candles1m[candles1m.length - i].t - candles1m[candles1m.length - i - 1].t > 120000) {
      return null; // مشکل فاصله کندل‌ها در 1 دقیقه
    }
  }

  let triggerLong = false;
  let triggerShort = false;

  if (isLong5m) {
    triggerLong = isBullishRejection(last1m);
  }
  if (isShort5m) {
    triggerShort = isBearishRejection(last1m);
  }

  if (!triggerLong && !triggerShort) return null;

  // ۵. محاسبه SL و TP بر اساس کانال ۱۵ دقیقه
  const entry = last1m.c;
  const atr5m = calcATR(candles5m, 14);
  let sl, tp, side, reason;

  if (triggerLong) {
    side = "LONG";
    reason = "5m EMA50 Breakout + 15m Channel Filter + 1m Trigger";
    sl = ch15m.lower2_0;  // استاپ روی کف کانال 2
    tp = ch15m.upper1_4;  // تارگت روی سقف کانال 1.4
    
    if (entry <= sl || tp <= entry) return null; 
  } else {
    side = "SHORT";
    reason = "5m EMA50 Breakdown + 15m Channel Filter + 1m Trigger";
    sl = ch15m.upper2_0;  // استاپ روی سقف کانال 2
    tp = ch15m.lower1_4;  // تارگت روی کف کانال 1.4
    
    if (entry >= sl || tp >= entry) return null; 
  }

  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const rr = tpDist / slDist;

  // ۶. بررسی نسبت ریسک به ریوارد (حداقل 1.2)
  if (rr < 1.2) return null;

  return {
    engine: "ENGINE_2_MTF_V9", // ✅ نام موتور اصلاح شد
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp,
    slDist,
    tpDist,
    rr: Number(rr.toFixed(2)),
    reason,
    atr: atr5m, // ✅ ATR واقعی محاسبه شد
    candleTime: curr5m.t,
    timestamp: Date.now()
  };
}
