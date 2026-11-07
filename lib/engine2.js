// lib/engine2.js
// Engine 2 — TSR (Trendlines & Pivots) + MACD
// v4.1.0 — Exact translation of Pine Script TSR logic (Slanted Trendlines) + MACD arrows.

export const ENGINE2_VERSION = "4.1.0 (TSR Trendlines + MACD)";

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return [];
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [e];
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function calcMACD(closes) {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const len = Math.min(e12.length, e26.length);
  if (len === 0) return { macdLine: [], signalLine: [], hist: [] };
  const macdLine = [];
  for (let i = 0; i < len; i++) macdLine.push(e12[i] - e26[i]);
  const signalLine = emaSeries(macdLine, 9);
  const hist = [];
  for (let i = 0; i < signalLine.length; i++) {
    hist.push(macdLine[i + (macdLine.length - signalLine.length)] - signalLine[i]);
  }
  return { macdLine, signalLine, hist };
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

// تابع پیدا کردن پیوت‌ها دقیقاً مثل ta.pivothigh(20, 20)
function getPivots(candles, length = 20) {
  const highs = [];
  const lows = [];
  
  for (let i = length; i < candles.length - length; i++) {
    let isHigh = true;
    let isLow = true;
    
    // چک کردن سمت چپ و راست برای سقف
    for (let j = 1; j <= length; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) {
        isHigh = false;
      }
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) {
        isLow = false;
      }
    }
    
    if (isHigh) highs.push({ price: candles[i].h, index: i });
    if (isLow) lows.push({ price: candles[i].l, index: i });
  }
  return { highs, lows };
}

// محاسبه قیمت روی خط روند در ایندکس فعلی
function getTrendlinePrice(p1, p2, currentIndex) {
  const m = (p2.price - p1.price) / (p2.index - p1.index);
  const b = p1.price - m * p1.index;
  return m * currentIndex + b;
}

export function detectSignalEngine2(symbol, timeframe, candles) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles) || candles.length < 100) return null;

  const closes = candles.map(c => c.c);
  const currentIndex = candles.length - 1;
  const price = closes[currentIndex];
  const high = candles[currentIndex].h;
  const low = candles[currentIndex].l;

  // محاسبه MACD
  const { hist } = calcMACD(closes);
  if (hist.length < 2) return null;
  const currentHist = hist[hist.length - 1] || 0;
  const prevHist = hist[hist.length - 2] || 0;

  const atrVal = calcATR(candles, 14);
  if (!(atrVal > 0)) return null;

  // پیدا کردن پیوت‌ها (طول 20 مثل اندیکاتور)
  const pivots = getPivots(candles, 20);
  
  let side = null;
  let reason = "";

  // بررسی خط روند نزولی (Downtrend)
  if (pivots.highs.length >= 2) {
    const p1 = pivots.highs[pivots.highs.length - 2];
    const p2 = pivots.highs[pivots.highs.length - 1];
    
    if (p1.price > p2.price && p1.index < p2.index) { // شیب نزولی
      const trendPrice = getTrendlinePrice(p1, p2, currentIndex);
      
      // اگر قیمت خط روند را به بالا بشکند (Breakout)
      if (high >= trendPrice && currentHist > 0 && prevHist < currentHist) {
        side = "LONG";
        reason = `5m: شکست خط روند نزولی (${trendPrice.toFixed(4)}) + تایید MACD صعودی.`;
      }
      // اگر قیمت به خط روند برخورد کند و برگشت بزند (Rejection)
      else if (Math.abs(high - trendPrice) / trendPrice < 0.002 && currentHist < 0) {
        side = "SHORT";
        reason = `5m: برخورد با خط روند نزولی (${trendPrice.toFixed(4)}) + تایید MACD نزولی.`;
      }
    }
  }

  // بررسی خط روند صعودی (Uptrend) - اگر هنوز سیگنالی نداریم
  if (!side && pivots.lows.length >= 2) {
    const p1 = pivots.lows[pivots.lows.length - 2];
    const p2 = pivots.lows[pivots.lows.length - 1];
    
    if (p1.price < p2.price && p1.index < p2.index) { // شیب صعودی
      const trendPrice = getTrendlinePrice(p1, p2, currentIndex);
      
      // اگر قیمت خط روند را به پایین بشکند (Breakdown)
      if (low <= trendPrice && currentHist < 0 && prevHist > currentHist) {
        side = "SHORT";
        reason = `5m: شکست خط روند صعودی (${trendPrice.toFixed(4)}) + تایید MACD نزولی.`;
      }
      // اگر قیمت به خط روند برخورد کند و برگشت بزند
      else if (Math.abs(low - trendPrice) / trendPrice < 0.002 && currentHist > 0) {
        side = "LONG";
        reason = `5m: برخورد با خط روند صعودی (${trendPrice.toFixed(4)}) + تایید MACD صعودی.`;
      }
    }
  }

  // بررسی حمایت و مقاومت افقی (پشتیبانی برای مواقعی که خط روند نیست)
  if (!side) {
    const lastHigh = pivots.highs.length > 0 ? pivots.highs[pivots.highs.length - 1].price : null;
    const lastLow = pivots.lows.length > 0 ? pivots.lows[pivots.lows.length - 1].price : null;
    
    if (lastHigh && Math.abs(high - lastHigh) / lastHigh < 0.002 && currentHist < 0) {
        side = "SHORT";
        reason = `5m: برخورد با مقاومت افقی (${lastHigh.toFixed(4)}) + MACD نزولی.`;
    } else if (lastLow && Math.abs(low - lastLow) / lastLow < 0.002 && currentHist > 0) {
        side = "LONG";
        reason = `5m: برخورد با حمایت افقی (${lastLow.toFixed(4)}) + MACD صعودی.`;
    }
  }

  if (!side) return null;

  const slDist = atrVal * 1.5;
  const tpDist = slDist * 2.0;

  const entry = price;
  const sl = side === "LONG" ? entry - slDist : entry + slDist;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  return {
    engine: "ENGINE_2_TSR",
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
    atr: atrVal,
    candleTime: candles[candles.length - 1].t,
    timestamp: Date.now()
  };
}
