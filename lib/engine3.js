// lib/engine3.js
// ⚠️⚠️⚠️ هشدار مهم: این نسخه اصلی (v1.0.2) نیست! ⚠️⚠️⚠️
// این یک نسخه آزمایشی (Experimental) بر اساس اندیکاتور v7 است.
// هدف: حذف فیلتر روند و ورود در هر جهت با تاییدیه‌های کندلی.
// برای بازگشت به نسخه اصلی، فایل بک‌آپ (engine3----back.js) را جایگزین کنید.
// نسخه: 2.0.0-Experimental (No Trend Filter)

export const ENGINE3_VERSION = "2.0.0-Experimental (No Trend Filter)";

// توابع کمکی محاسبات ریاضی
function calcSMA(data, period) {
  if (data.length < period) return 0;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcStDev(data, period) {
  if (data.length < period) return 0;
  const slice = data.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMAArray(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [e];
  for (let i = period; i < data.length; i++) {
    e = data[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function calcADX(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2 + 2) return 0;
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
    const pdi = 100 * pS / trS;
    const mdi = 100 * mS / trS;
    const s = pdi + mdi;
    return s === 0 ? 0 : 100 * Math.abs(pdi - mdi) / s;
  };
  dx.push(computeDx());
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + pdm[i];
    mS = mS - mS / period + mdm[i];
    dx.push(computeDx());
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += dx[i];
  a /= period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
  return a;
}

function calcMACD(closes) {
  const ema12 = calcEMAArray(closes, 12);
  const ema26 = calcEMAArray(closes, 26);
  if (ema12.length < 26 || ema26.length < 26) return { macdHist: 0, macdLine: 0, sigLine: 0, macdLinePrev: 0, sigLinePrev: 0 };
  const macdArr = [];
  for (let i = 0; i < ema26.length; i++) macdArr.push(ema12[ema12.length - ema26.length + i] - ema26[i]);
  const sigArr = calcEMAArray(macdArr, 9);
  const macdLine = macdArr[macdArr.length - 1];
  const sigLine = sigArr.length ? sigArr[sigArr.length - 1] : 0;
  const macdHist = macdLine - sigLine;
  const macdLinePrev = macdArr.length > 1 ? macdArr[macdArr.length - 2] : 0;
  const sigLinePrev = sigArr.length > 1 ? sigArr[sigArr.length - 2] : 0;
  return { macdHist, macdLine, sigLine, macdLinePrev, sigLinePrev };
}

function calcSlope(src, len) {
  if (src.length < len) return { slope: 0, intercept: 0 };
  const n = len;
  let sumX = n * (n - 1) / 2;
  let sumXX = n * (n - 1) * (2 * n - 1) / 6;
  let sumY = 0, sumXY = 0;
  // محاسبه دقیق شیب طبق کد Pine Script
  const slice = src.slice(src.length - len);
  for (let i = 0; i < len; i++) {
    sumY += slice[i];
    sumXY += i * slice[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
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

// ---------------------------------------------------------
// تابع اصلی تشخیص سیگنال
// ---------------------------------------------------------
export function detectSignalEngine3(symbol, timeframe, candles15m) {
  if (timeframe !== "15m") return null; 
  if (!Array.isArray(candles15m) || candles15m.length < 250) return null; // نیاز به حداقل ۲۰۰ کندل برای کانال + ۵۰ برای MA

  // تنظیمات (طبق عکس‌های اندیکاتور)
  const chPeriod = 200;
  const chWidth = 2.0;
  const sgSens = 1.5;
  const flRSIOverb = 70;
  const flRSIOversold = 30;
  const flADXThresh = 20;
  const flMA = 50;
  const volMult = 1.5;

  const closes = candles15m.map(c => c.c);
  const volumes = candles15m.map(c => c.v);
  const opens = candles15m.map(c => c.o);

  const currentCandle = candles15m[candles15m.length - 1];
  const close = currentCandle.c;
  const open = currentCandle.o;
  const volume = currentCandle.v;

  // ۱. محاسبه کانال (دقیقاً مثل Pine Script)
  const { slope, intercept } = calcSlope(closes, chPeriod);
  const stdDev = calcStDev(closes, chPeriod);
  const endY = intercept + slope * (chPeriod - 1);
  const upVal = endY + chWidth * stdDev;
  const dnVal = endY - chWidth * stdDev;
  
  const dLow = Math.abs(close - dnVal) / dnVal * 100;
  const dUp = Math.abs(close - upVal) / upVal * 100;

  // ۲. محاسبات اندیکاتورهای تاییدیه
  const rsi = calcRSI(closes, 14);
  const rsiPrev = calcRSI(closes.slice(0, -1), 14);
  const adx = calcADX(candles15m, 14);
  const volMA = calcSMA(volumes, 20);
  const volHigh = volume > volMA * volMult;
  const macdData = calcMACD(closes);
  const maVal = calcSMA(closes, flMA);
  const atr = calcATR(candles15m, 14);

  // ۳. شرایط فیلترها
  const volOK = volHigh;
  const rsiOKBuy = rsi < flRSIOverb && (rsi < 60 || (rsi < rsiPrev + 2 && rsi < 55));
  const rsiOKSell = rsi > flRSIOversold && (rsi > 40 || (rsi > rsiPrev - 2 && rsi > 45));
  const adxOK = adx > flADXThresh;
  const macdOKBuy = macdData.macdHist > 0 || (macdData.macdLine > macdData.macdLinePrev && macdData.sigLine > macdData.sigLinePrev);
  const macdOKSell = macdData.macdHist < 0 || (macdData.macdLine < macdData.macdLinePrev && macdData.sigLine < macdData.sigLinePrev);
  const maOKBuy = close > maVal;
  const maOKSell = close < maVal;

  let side = null;
  let reason = "";

  // ۴. منطق سیگنال (بدون در نظر گرفتن روند - فیلتر روند حذف شده است)
  
  // بررسی سیگنال خرید (برخورد به کف کانال + فیلترها)
  if (dLow < sgSens && close > open) {
    if (volOK && rsiOKBuy && adxOK && macdOKBuy && maOKBuy) {
      side = "LONG"; reason = "BUY+ (Channel Bottom)";
    }
  }
  
  // بررسی سیگنال فروش (برخورد به سقف کانال + فیلترها)
  if (!side && dUp < sgSens && close < open) {
    if (volOK && rsiOKSell && adxOK && macdOKSell && maOKSell) {
      side = "SHORT"; reason = "SELL+ (Channel Top)";
    }
  }

  if (!side) return null;

  // ۵. محاسبه حد ضرر و حد سود طبق دستور شما
  const entry = close;
  let sl, tp;

  if (side === "LONG") {
    // حد ضرر: پایین‌تر از کف کندل سیگنال
    sl = currentCandle.l - (atr * 0.1); // یک بافر کوچک برای جلوگیری از نویز
    const risk = entry - sl;
    if (risk <= 0) return null;
    tp = entry + (risk * 2); // نسبت ریسک به ریوارد 1:2
  } else {
    // حد ضرر: بالاتر از سقف کندل سیگنال
    sl = currentCandle.h + (atr * 0.1);
    const risk = sl - entry;
    if (risk <= 0) return null;
    tp = entry - (risk * 2);
  }

  // محاسبه فاصله‌ها
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);

  return {
    engine: "ENGINE_3_TRENDLINE",
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
    atr,
    candleTime: currentCandle.t,
    timestamp: Date.now()
  };
}
