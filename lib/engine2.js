// lib/engine2.js
// Engine 2 — Multi-Timeframe (5m BOS + 1m Entry) + TSR
// v6.0.0 — Structure in 5m, precise entry in 1m. TP/SL based on 5m.

export const ENGINE2_VERSION = "6.0.0 (5m BOS + 1m Entry)";

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

export function detectSignalEngine2(symbol, timeframe, candles5m, candles1m) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles5m) || candles5m.length < 100) return null;
  if (!Array.isArray(candles1m) || candles1m.length < 50) return null;

  // فقط کندل‌های بسته شده ۵ دقیقه
  const closed5m = candles5m.slice(0, -1);
  const currentIdx5m = closed5m.length - 1;
  const last5m = closed5m[currentIdx5m];
  const prev5m = closed5m[currentIdx5m - 1];

  const atr5m = calcATR(closed5m, 14);
  if (!(atr5m > 0)) return null;

  const pivots5m = getPivots(closed5m, 20);
  let side = null;
  let reason = "";

  const tolerancePct = 0.003; // حساسیت برخورد 0.3%

  // ۱. بررسی سیگنال فروش در ۵ دقیقه (برخورد با مقاومت + BOS نزولی)
  if (pivots5m.highs.length >= 2) {
    const p1 = pivots5m.highs[pivots5m.highs.length - 2];
    const p2 = pivots5m.highs[pivots5m.highs.length - 1];
    
    if (p1.price > p2.price && p2.index - p1.index > 2) {
      const trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      
      // BOS نزولی: کندل فعلی باید کف کندل قبلی را بشکند و قرمز باشد
      const isBosBearish = last5m.c < prev5m.l && last5m.c < last5m.o;

      if (Math.abs(last5m.h - trendPrice) / trendPrice < tolerancePct && isBosBearish) {
        side = "SHORT";
        reason = `5m: برخورد با سقف/خط نزولی (${trendPrice.toFixed(4)}) + شکست ساختار نزولی (BOS).`;
      }
    }
  }

  // ۲. بررسی سیگنال خرید در ۵ دقیقه (برخورد با حمایت + BOS صعودی)
  if (!side && pivots5m.lows.length >= 2) {
    const p1 = pivots5m.lows[pivots5m.lows.length - 2];
    const p2 = pivots5m.lows[pivots5m.lows.length - 1];
    
    if (p1.price < p2.price && p2.index - p1.index > 2) {
      const trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      
      // BOS صعودی: کندل فعلی باید سقف کندل قبلی را بشکند و سبز باشد
      const isBosBullish = last5m.c > prev5m.h && last5m.c > last5m.o;

      if (Math.abs(last5m.l - trendPrice) / trendPrice < tolerancePct && isBosBullish) {
        side = "LONG";
        reason = `5m: برخورد با کف/خط صعودی (${trendPrice.toFixed(4)}) + شکست ساختار صعودی (BOS).`;
      }
    }
  }

  if (!side) return null;

  // ۳. یافتن نقطه ورود دقیق در تایم ۱ دقیقه
  const closed1m = candles1m.slice(0, -1);
  const current1m = closed1m[closed1m.length - 1];
  
  let entryPrice = current1m.c; // ورود در قیمت بسته شدن کندل تایید ۱ دقیقه

  // ۴. محاسبه TP و SL بر اساس ساختار تایم ۵ دقیقه
  const slDist = atr5m * 1.5;
  const tpDist = slDist * 2.0;

  const entry = entryPrice; 
  const sl = side === "LONG" ? last5m.l - (atr5m * 0.5) : last5m.h + (atr5m * 0.5); 
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  return {
    engine: "ENGINE_2_MTF_V6",
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp,
    slDist: Math.abs(entry - sl),
    tpDist: Math.abs(entry - tp),
    rr: 2.0,
    reason,
    atr: atr5m,
    candleTime: last5m.t,
    timestamp: Date.now()
  };
}
