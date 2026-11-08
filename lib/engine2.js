// lib/engine2.js
// Engine 2 — Multi-Timeframe (5m TSR Structure + 1m EMA9 Entry)
// v8.2.2 — Added 1m RSI, Overextension & Local Resistance Filters.

export const ENGINE2_VERSION = "8.2.2 (1m Safety Filters)";

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

// ✅ تابع جدید محاسبه RSI برای تایم 1 دقیقه
function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
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

function isBullishRejection(candle) {
  if (!candle) return false;
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  const body = Math.abs(candle.c - candle.o);
  const lowerWick = Math.min(candle.c, candle.o) - candle.l;
  return candle.c > candle.o && (lowerWick >= range * 0.25 || body >= range * 0.45);
}

function isBearishRejection(candle) {
  if (!candle) return false;
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  const body = Math.abs(candle.c - candle.o);
  const upperWick = candle.h - Math.max(candle.c, candle.o);
  return candle.c < candle.o && (upperWick >= range * 0.25 || body >= range * 0.45);
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
  let trendPrice = 0;
  let reason = "";
  
  const tolerancePct = 0.005;

  // ۱. بررسی ۵ دقیقه (خطوط روند)
  if (pivots5m.highs.length >= 2) {
    const p1 = pivots5m.highs[pivots5m.highs.length - 2];
    const p2 = pivots5m.highs[pivots5m.highs.length - 1];
    
    if (p1.price > p2.price && p2.index - p1.index > 2) {
      trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      const nearPivotHigh = p2.price && Math.abs(last5m.h - p2.price) / p2.price < 0.005;

      if (Math.abs(last5m.h - trendPrice) / trendPrice < tolerancePct) {
        side = "SHORT";
        reason = `5m: برخورد با سقف/خط نزولی (${trendPrice.toFixed(4)})`;
        if (nearPivotHigh) reason += ` + هم‌پوشانی با سقف قبلی`;
      }
    }
  }

  if (!side && pivots5m.lows.length >= 2) {
    const p1 = pivots5m.lows[pivots5m.lows.length - 2];
    const p2 = pivots5m.lows[pivots5m.lows.length - 1];
    
    if (p1.price < p2.price && p2.index - p1.index > 2) {
      trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      const nearPivotLow = p2.price && Math.abs(last5m.l - p2.price) / p2.price < 0.005;

      if (Math.abs(last5m.l - trendPrice) / trendPrice < tolerancePct) {
        side = "LONG";
        reason = `5m: برخورد با کف/خط صعودی (${trendPrice.toFixed(4)})`;
        if (nearPivotLow) reason += ` + هم‌پوشانی با کف قبلی`;
      }
    }
  }

  if (!side) return null;

  // ۲. بررسی کندل برگشتی ۵ دقیقه
  if (side === "LONG" && !isBullishRejection(last5m)) return null;
  if (side === "SHORT" && !isBearishRejection(last5m)) return null;
  reason += ` + کندل تایید برگشتی`;

  // ۳. بررسی ماشه و فیلترهای امنیتی تایم ۱ دقیقه
  const current1m = candles1m[candles1m.length - 1]; 
  const closes1m = candles1m.map(c => c.c);
  const ema9_1m = ema(closes1m, 9);
  const rsi1m = calcRSI(closes1m, 14);

  // شرط عبور از EMA9
  if (side === "LONG" && current1m.c < (ema9_1m * 0.999)) return null; 
  if (side === "SHORT" && current1m.c > (ema9_1m * 1.001)) return null; 

  // 🛑 فیلتر ۱: RSI تایم ۱ دقیقه (جلوگیری از خرید در اشباع خرید)
  if (side === "LONG" && rsi1m >= 70) return null;
  if (side === "SHORT" && rsi1m <= 30) return null;

  // 🛑 فیلتر ۲: فاصله از EMA9 (جلوگیری از ورود در کندل‌های اسپایک و بسیار بلند)
  const distFromEmaPct = Math.abs(current1m.c - ema9_1m) / ema9_1m;
  if (distFromEmaPct > 0.003) return null; // اگر بیش از 0.3% از EMA9 فاصله گرفته باشد، سیگنال نمی‌دهد

  // 🛑 فیلتر ۳: بررسی مقاومت/حمایت محلی در تایم ۱ دقیقه (۱۵ کندل اخیر)
  const recent15m = candles1m.slice(-15);
  if (side === "LONG") {
    const localHigh1m = Math.max(...recent15m.map(c => c.h));
    if (current1m.c >= localHigh1m * 0.999) return null; // نزدیک سقف ۱۵ کندل اخیر ۱ دقیقه
  } else {
    const localLow1m = Math.min(...recent15m.map(c => c.l));
    if (current1m.c <= localLow1m * 1.001) return null; // نزدیک کف ۱۵ کندل اخیر ۱ دقیقه
  }

  reason += ` + تایید 1m (EMA9 + RSI + Distance)`;

  // ۴. محاسبه TP و SL
  const entry = current1m.c; 
  const sl = side === "LONG" ? last5m.l - (atr5m * 0.2) : last5m.h + (atr5m * 0.2);
  const slDist = Math.abs(entry - sl);

  if (slDist < atr5m * 0.5 || slDist > atr5m * 2.5) return null;

  const tpDist = slDist * 2.0;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  // چک ایمنی نهایی
  if (side === "LONG" && (sl >= entry || tp <= entry)) return null;
  if (side === "SHORT" && (sl <= entry || tp >= entry)) return null;

  const rr = tpDist / slDist;
  if (rr < 1.5) return null; 

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
