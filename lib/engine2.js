// lib/engine2.js
// Engine 2 — Multi-Timeframe (5m TSR + Schiff Pitchfork + Patterns)
// v8.4.1 — Added Schiff Pitchfork logic (3-Pivot calculation) alongside Trendlines.

export const ENGINE2_VERSION = "8.4.1 (Pitchfork + Patterns)";

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

function getLinePrice(p1_price, p1_idx, p2_price, p2_idx, currentIdx) {
  const m = (p2_price - p1_price) / (p2_idx - p1_idx);
  const b = p1_price - m * p1_idx;
  return m * currentIdx + b;
}

// ==========================================
// ✅ توابع تشخیص Schiff Pitchfork
// ==========================================
function checkPitchfork(candles, side) {
  const pivots = getPivots(candles, 10); // پیدا کردن پیوت‌های نزدیک‌تر برای Pitchfork
  if (side === "LONG") {
    if (pivots.lows.length < 2 || pivots.highs.length < 1) return false;
    // پیدا کردن سه نقطه: کف اول (P0)، سقف وسط (P1)، کف آخر (P2)
    const p2 = pivots.lows[pivots.lows.length - 1];
    const p1 = pivots.highs.filter(h => h.index > p2.index - 20 && h.index < p2.index).pop(); 
    const p0 = pivots.lows.filter(l => l.index < p1?.index).pop();

    if (!p0 || !p1 || !p2) return false;

    // فرمول Schiff: شیفت دادن نقطه شروع به سمت جلو
    const shifted_p0_price = p0.price + (p1.price - p0.price) / 2;
    
    // خط میانه (Median Line) از P0 شیفت یافته تا وسط P1 و P2
    const mid_idx = (p1.index + p2.index) / 2;
    const mid_price = (p1.price + p2.price) / 2;
    const currentIdx = candles.length - 1;
    const medianLinePrice = getLinePrice(shifted_p0_price, p0.index, mid_price, mid_idx, currentIdx);
    
    // خط موازی پایینی (Lower Parallel) از P2 شروع می‌شود و موازی خط میانه است
    const slope = (mid_price - shifted_p0_price) / (mid_idx - p0.index);
    const lowerParallelPrice = p2.price + slope * (currentIdx - p2.index);

    // آیا قیمت به خط موازی پایینی یا خط میانه نزدیک شده است؟
    const tolerance = atr(candles, 14) * 0.3;
    const lastClose = candles[currentIdx].c;
    
    if (Math.abs(lastClose - lowerParallelPrice) < tolerance || Math.abs(lastClose - medianLinePrice) < tolerance) {
      return true;
    }
  } else {
    if (pivots.highs.length < 2 || pivots.lows.length < 1) return false;
    // پیدا کردن سه نقطه: سقف اول (P0)، کف وسط (P1)، سقف آخر (P2)
    const p2 = pivots.highs[pivots.highs.length - 1];
    const p1 = pivots.lows.filter(l => l.index > p2.index - 20 && l.index < p2.index).pop(); 
    const p0 = pivots.highs.filter(h => h.index < p1?.index).pop();

    if (!p0 || !p1 || !p2) return false;

    const shifted_p0_price = p0.price - (p0.price - p1.price) / 2;
    const mid_idx = (p1.index + p2.index) / 2;
    const mid_price = (p1.price + p2.price) / 2;
    const currentIdx = candles.length - 1;
    const medianLinePrice = getLinePrice(shifted_p0_price, p0.index, mid_price, mid_idx, currentIdx);
    
    const slope = (mid_price - shifted_p0_price) / (mid_idx - p0.index);
    const upperParallelPrice = p2.price + slope * (currentIdx - p2.index);

    const tolerance = atr(candles, 14) * 0.3;
    const lastClose = candles[currentIdx].c;
    
    if (Math.abs(lastClose - upperParallelPrice) < tolerance || Math.abs(lastClose - medianLinePrice) < tolerance) {
      return true;
    }
  }
  return false;
}

function isBullishStructure(candles) {
  const { highs, lows } = getPivots(candles, 10);
  if (highs.length < 2 || lows.length < 2) return false;
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  const lastClose = candles[candles.length - 1].c;
  return (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price && lastClose > lastHigh.price);
}

function isBearishStructure(candles) {
  const { highs, lows } = getPivots(candles, 10);
  if (highs.length < 2 || lows.length < 2) return false;
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  const lastClose = candles[candles.length - 1].c;
  return (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price && lastClose < lastLow.price);
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

function isBullishEngulfing(candles) {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  return prev.c < prev.o && cur.c > cur.o && cur.c > prev.o && cur.o < prev.c;
}

function isBearishEngulfing(candles) {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  return prev.c > prev.o && cur.c < cur.o && cur.o > prev.c && cur.c < prev.o;
}

function isHammer(c) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  return (range > 3 * Math.abs(c.o - c.c)) && ((Math.min(c.o, c.c) - c.l) > 2 * (c.h - Math.max(c.o, c.c)));
}

function isShootingStar(c) {
  if (!c) return false;
  const range = c.h - c.l;
  if (range <= 0) return false;
  return (range > 3 * Math.abs(c.o - c.c)) && ((c.h - Math.max(c.o, c.c)) > 2 * (Math.min(c.o, c.c) - c.l));
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
  
  const tolerancePct = 0.006;

  // ۱. بررسی برخورد با خطوط روند معمولی
  if (pivots5m.highs.length >= 2) {
    const p1 = pivots5m.highs[pivots5m.highs.length - 2];
    const p2 = pivots5m.highs[pivots5m.highs.length - 1];
    if (p1.price > p2.price) {
      trendPrice = getLinePrice(p1.price, p1.index, p2.price, p2.index, currentIdx5m);
      if (trendPrice > 0 && Math.abs(last5m.h - trendPrice) / trendPrice < tolerancePct) {
        side = "SHORT";
        reason = `5m: برخورد با سقف/خط نزولی (${trendPrice.toFixed(4)})`;
      }
    }
  }

  if (!side && pivots5m.lows.length >= 2) {
    const p1 = pivots5m.lows[pivots5m.lows.length - 2];
    const p2 = pivots5m.lows[pivots5m.lows.length - 1];
    if (p1.price < p2.price) {
      trendPrice = getLinePrice(p1.price, p1.index, p2.price, p2.index, currentIdx5m);
      if (trendPrice > 0 && Math.abs(last5m.l - trendPrice) / trendPrice < tolerancePct) {
        side = "LONG";
        reason = `5m: برخورد با کف/خط صعودی (${trendPrice.toFixed(4)})`;
      }
    }
  }

  // ۲. بررسی Schiff Pitchfork (اگر با خط روند معمولی سیگنال نداشتیم)
  if (!side) {
    if (checkPitchfork(candles5m, "LONG")) {
      side = "LONG";
      reason = "5m: برخورد با خط پایینی چنگال (Schiff Pitchfork)";
    } else if (checkPitchfork(candles5m, "SHORT")) {
      side = "SHORT";
      reason = "5m: برخورد با خط بالایی چنگال (Schiff Pitchfork)";
    }
  }

  if (!side) return null;

  // ۳. فیلتر ساختار بازار (SMC) و الگوهای کندلی
  let hasValidPattern = false;
  let patternName = "";
  
  if (side === "LONG") {
    if (!isBullishStructure(candles5m)) return null;
    if (isBullishRejection(last5m)) { hasValidPattern = true; patternName = "کندل برگشتی"; }
    else if (isBullishEngulfing(candles5m)) { hasValidPattern = true; patternName = "پوشاننده صعودی"; }
    else if (isHammer(last5m)) { hasValidPattern = true; patternName = "چکش"; }
  } else if (side === "SHORT") {
    if (!isBearishStructure(candles5m)) return null;
    if (isBearishRejection(last5m)) { hasValidPattern = true; patternName = "کندل برگشتی"; }
    else if (isBearishEngulfing(candles5m)) { hasValidPattern = true; patternName = "پوشاننده نزولی"; }
    else if (isShootingStar(last5m)) { hasValidPattern = true; patternName = "ستاره دنباله‌دار"; }
  }

  if (!hasValidPattern) return null;
  reason += ` + الگوی ${patternName}`;

  // ۴. تاییدیه 1 دقیقه (EMA9)
  const current1m = candles1m[candles1m.length - 1]; 
  const closes1m = candles1m.map(c => c.c);
  const ema9_1m = ema(closes1m, 9);

  if (side === "LONG" && current1m.c <= ema9_1m) return null; 
  if (side === "SHORT" && current1m.c >= ema9_1m) return null; 
  reason += ` + تایید 1m (EMA9)`;

  const entry = current1m.c; 
  
  // ۵. محاسبه SL/TP
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
