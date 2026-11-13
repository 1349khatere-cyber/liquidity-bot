// lib/engine2.js
// Engine 2 — MTF Channel & EMA50 Momentum
// v9.0.0 — Complete rewrite based on user strategy: 15m Channel Filter, 5m EMA50 Momentum, 1m Trigger.

export const ENGINE2_VERSION = "9.0.0 (15m Channel + 5m EMA50)";

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

// محاسبه کانال رگرسیون برای تایم 15 دقیقه
function getRegressionData(candles, length = 200) {
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
  if (!Array.isArray(candles15m) || candles15m.length < 200) return null;

  // ۱. فیلتر رنج فشرده در تایم ۵ دقیقه
  const adx5m = adx(candles5m, 14);
  if (!Number.isFinite(adx5m) || adx5m < 20) {
    return null; // بازار رنج فشرده است، وارد نمی‌شویم
  }

  const ema50_5m = ema(candles5m.map(c => c.c), 50);
  const prev5m = candles5m[candles5m.length - 2];
  const curr5m = candles5m[candles5m.length - 1];

  // ۲. شرط ورود در تایم ۵ دقیقه (بدون توجه به شیب کانال)
  // فروش: کندل قبلی زیر EMA50، کندل فعلی هم زیر کندل قبلی
  const isShort5m = prev5m.c < ema50_5m && curr5m.c < prev5m.c && curr5m.c < ema50_5m;
  // خرید: کندل قبلی بالای EMA50، کندل فعلی هم بالای کندل قبلی
  const isLong5m = prev5m.c > ema50_5m && curr5m.c > prev5m.c && curr5m.c > ema50_5m;

  if (!isShort5m && !isLong5m) return null;

  // ۳. فیلتر تایم ۱۵ دقیقه (کانال ۲۰۰ کندلی + EMA50)
  const ch15m = getRegressionData(candles15m, 200);
  const ema50_15m = ema(candles15m.map(c => c.c), 50);
  const curr15m = candles15m[candles15m.length - 1];

  const isUptrend15m = ch15m.slope > 0;
  const isDowntrend15m = ch15m.slope < 0;

  // شرط مهار خرید در روند نزولی
  if (isLong5m) {
    const inUpperZone = curr15m.c >= ch15m.upper1_4 && curr15m.c <= ch15m.upper2_0;
    if (isDowntrend15m && inUpperZone && curr15m.c > ema50_15m) {
      return null; // بلاک شده توسط فیلتر 15 دقیقه
    }
  }

  // شرط مهار فروش در روند صعودی
  if (isShort5m) {
    const inLowerZone = curr15m.c <= ch15m.lower1_4 && curr15m.c >= ch15m.lower2_0;
    if (isUptrend15m && inLowerZone && curr15m.c < ema50_15m) {
      return null; // بلاک شده توسط فیلتر 15 دقیقه
    }
  }

  // ۴. تریگر ۱ دقیقه و بررسی گپ
  const last1m = candles1m[candles1m.length - 1];
  const prev1m = candles1m[candles1m.length - 2];

  // بررسی گپ (اگر فاصله زمانی بین دو کندل بیشتر از 2 دقیقه بود)
  if (last1m.t - prev1m.t > 120000) {
    return null; // مشکل فاصله کندل‌ها در 1 دقیقه
  }

  let triggerLong = false;
  let triggerShort = false;

  if (isLong5m) {
    triggerLong = isBullishRejection(last1m) || (last1m.c > last1m.o);
  }
  if (isShort5m) {
    triggerShort = isBearishRejection(last1m) || (last1m.c < last1m.o);
  }

  if (!triggerLong && !triggerShort) return null;

  // ۵. محاسبه SL و TP بر اساس کانال ۱۵ دقیقه
  const entry = last1m.c;
  let sl, tp, side, reason;

  if (triggerLong) {
    side = "LONG";
    reason = "5m EMA50 Breakout + 15m Channel Filter";
    sl = ch15m.lower2_0;  // استاپ روی کف کانال 2
    tp = ch15m.upper1_4;  // تارگت روی سقف کانال 1.4
    
    if (entry <= sl || tp <= entry) return null; // نسبت ریسک به ریوارد نامعتبر
  } else {
    side = "SHORT";
    reason = "5m EMA50 Breakdown + 15m Channel Filter";
    sl = ch15m.upper2_0;  // استاپ روی سقف کانال 2
    tp = ch15m.lower1_4;  // تارگت روی کف کانال 1.4
    
    if (entry >= sl || tp >= entry) return null; // نسبت ریسک به ریوارد نامعتبر
  }

  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);

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
    rr: Number((tpDist / slDist).toFixed(2)),
    reason,
    atr: 0, // این استراتژی به ATR نیاز ندارد، اما برای سازگاری با کد فعلی صفر می‌گذاریم
    candleTime: curr5m.t,
    timestamp: Date.now()
  };
}
