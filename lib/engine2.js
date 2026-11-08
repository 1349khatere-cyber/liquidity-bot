// lib/engine2.js
// Engine 2 — Multi-Timeframe (5m TSR Structure + 1m EMA9 Entry)
// v8.1.0 — Fixed candle slicing, Real RR, Structural SL/TP, Rejection Candle.

export const ENGINE2_VERSION = "8.1.0 (MTF Structure + Real RR)";

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

function getTrendlinePrice(p1, p2, currentIndex) {
  const m = (p2.price - p1.price) / (p2.index - p1.index);
  const b = p1.price - m * p1.index;
  return m * currentIndex + b;
}

// تشخیص کندل برگشتی (Rejection Candle)
function isBullishRejection(candle) {
  if (!candle) return false;
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  const body = Math.abs(candle.c - candle.o);
  const lowerWick = Math.min(candle.c, candle.o) - candle.l;
  // کندل باید سبز باشد و سایه پایینی بلندی داشته باشد (چکش)
  return candle.c > candle.o && (lowerWick > range * 0.4 || body > range * 0.6);
}

function isBearishRejection(candle) {
  if (!candle) return false;
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  const body = Math.abs(candle.c - candle.o);
  const upperWick = candle.h - Math.max(candle.c, candle.o);
  // کندل باید قرمز باشد و سایه بالایی بلندی داشته باشد (ستاره ثاقب)
  return candle.c < candle.o && (upperWick > range * 0.4 || body > range * 0.6);
}

export function detectSignalEngine2(symbol, timeframe, candles5m, candles1m) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles5m) || candles5m.length < 100) return null;
  if (!Array.isArray(candles1m) || candles1m.length < 50) return null;

  // ❗️ دیگر slice(0, -1) نمی‌زنیم. دیتای ورودی از bot.js فقط کندل‌های بسته را دارد.
  const currentIdx5m = candles5m.length - 1;
  const last5m = candles5m[currentIdx5m];

  const atr5m = calcATR(candles5m, 14);
  if (!(atr5m > 0)) return null;

  const pivots5m = getPivots(candles5m, 20);
  let side = null;
  let trendPrice = 0;
  let reason = "";
  
  const tolerancePct = 0.003; // حساسیت برخورد 0.3%

  // ۱. بررسی برخورد با سقف/خط نزولی در ۵ دقیقه
  if (pivots5m.highs.length >= 2) {
    const p1 = pivots5m.highs[pivots5m.highs.length - 2];
    const p2 = pivots5m.highs[pivots5m.highs.length - 1];
    
    if (p1.price > p2.price && p2.index - p1.index > 2) {
      trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      
      if (Math.abs(last5m.h - trendPrice) / trendPrice < tolerancePct) {
        side = "SHORT";
        reason = `5m: برخورد با سقف/خط نزولی (${trendPrice.toFixed(4)})`;
      }
    }
  }

  // ۲. بررسی برخورد با کف/خط صعودی در ۵ دقیقه
  if (!side && pivots5m.lows.length >= 2) {
    const p1 = pivots5m.lows[pivots5m.lows.length - 2];
    const p2 = pivots5m.lows[pivots5m.lows.length - 1];
    
    if (p1.price < p2.price && p2.index - p1.index > 2) {
      trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      
      if (Math.abs(last5m.l - trendPrice) / trendPrice < tolerancePct) {
        side = "LONG";
        reason = `5m: برخورد با کف/خط صعودی (${trendPrice.toFixed(4)})`;
      }
    }
  }

  if (!side) return null;

  // ۳. بررسی تاییدیه کندل برگشتی در ۵ دقیقه (Rejection)
  if (side === "LONG" && !isBullishRejection(last5m)) return null;
  if (side === "SHORT" && !isBearishRejection(last5m)) return null;
  reason += ` + کندل تایید برگشتی`;

  // ۴. بررسی ماشه در تایم ۱ دقیقه با EMA9
  const current1m = candles1m[candles1m.length - 1]; // آخرین کندل 1m
  const closes1m = candles1m.map(c => c.c);
  const ema9_1m = ema(closes1m, 9);

  if (side === "LONG" && current1m.c <= ema9_1m) return null; 
  if (side === "SHORT" && current1m.c >= ema9_1m) return null; 
  reason += ` + تایید 1m (EMA9)`;

  // ۵. محاسبه TP و SL بر اساس ساختار ۵ دقیقه و فرمول واقعی RR
  const entry = current1m.c; 
  
  // SL ساختاری (کمی پایین‌تر از کف یا بالاتر از سقف)
  const sl = side === "LONG" ? last5m.l - (atr5m * 0.2) : last5m.h + (atr5m * 0.2);
  const slDist = Math.abs(entry - sl);

  // فیلتر فاصله SL با ATR (جلوگیری از استاپ‌های خیلی کوچک یا خیلی بزرگ)
  if (slDist < atr5m * 0.5 || slDist > atr5m * 2.5) return null;

  // TP بر اساس ریسک واقعی (حداقل 1.5 برابر ریسک)
  const tpDist = slDist * 2.0;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  const rr = tpDist / slDist; // محاسبه واقعی RR
  if (rr < 1.5) return null; // حداقل نسبت 1.5

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
