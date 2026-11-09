// lib/engine2.js
// Engine 2 — Multi-Timeframe (5m TSR Structure + 1m EMA9 Entry)
// v8.2.7 — Free Scalper (Removed strict 1m RSI/Distance filters).

export const ENGINE2_VERSION = "8.2.7 (Free Scalper)";

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
  
  const tolerancePct = 0.005; // 0.5%

  // بررسی برخورد با سقف/خط نزولی
  if (pivots5m.highs.length >= 2) {
    const p1 = pivots5m.highs[pivots5m.highs.length - 2];
    const p2 = pivots5m.highs[pivots5m.highs.length - 1];
    
    if (p1.price > p2.price) {
      trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      if (trendPrice > 0) {
        if (Math.abs(last5m.h - trendPrice) / trendPrice < tolerancePct) {
          side = "SHORT";
          reason = `5m: برخورد با سقف/خط نزولی (${trendPrice.toFixed(4)})`;
        }
      }
    }
  }

  // بررسی برخورد با کف/خط صعودی
  if (!side && pivots5m.lows.length >= 2) {
    const p1 = pivots5m.lows[pivots5m.lows.length - 2];
    const p2 = pivots5m.lows[pivots5m.lows.length - 1];
    
    if (p1.price < p2.price) {
      trendPrice = getTrendlinePrice(p1, p2, currentIdx5m);
      if (trendPrice > 0) {
        if (Math.abs(last5m.l - trendPrice) / trendPrice < tolerancePct) {
          side = "LONG";
          reason = `5m: برخورد با کف/خط صعودی (${trendPrice.toFixed(4)})`;
        }
      }
    }
  }

  if (!side) return null;

  // کندل تایید برگشتی در 5 دقیقه
  if (side === "LONG" && !isBullishRejection(last5m)) return null;
  if (side === "SHORT" && !isBearishRejection(last5m)) return null;
  reason += ` + کندل تایید برگشتی`;

  // ماشه در 1 دقیقه (فقط EMA9 - فیلترهای سخت حذف شدند)
  const current1m = candles1m[candles1m.length - 1]; 
  const closes1m = candles1m.map(c => c.c);
  const ema9_1m = ema(closes1m, 9);

  if (side === "LONG" && current1m.c <= ema9_1m) return null; 
  if (side === "SHORT" && current1m.c >= ema9_1m) return null; 
  reason += ` + تایید 1m (EMA9)`;

  const entry = current1m.c; 
  
  // محاسبه SL/TP بر اساس ساختار 5m
  const slBuffer = atr5m * 0.8;
  const sl = side === "LONG" ? last5m.l - slBuffer : last5m.h + slBuffer;
  const slDist = Math.abs(entry - sl);

  if (slDist < atr5m * 0.5 || slDist > atr5m * 4.0) return null;

  const tpDist = slDist * 2.0;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

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
