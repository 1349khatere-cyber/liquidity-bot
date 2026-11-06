// lib/engine2.js

export const ENGINE2_VERSION = "3.2.0 (15m + Reverse Exit + Range Filter)";

function ema(values, period) {
  if (values.length < period) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
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
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    );
    trs.push(tr);
  }
  let v = 0;
  for (let i = 0; i < period; i++) v += trs[i];
  v /= period;
  for (let i = period; i < trs.length; i++) {
    v = (v * (period - 1) + trs[i]) / period;
  }
  return v;
}

export function detectSignalEngine2(symbol, timeframe, candles) {
  // 🟢 تغییر تایم‌فریم به 15m
  if (timeframe !== "15m") return null;
  if (candles.length < 100) return null;

  // فیلتر رنج (Range Filter)
  const lookback = 20;
  const recentCandles = candles.slice(-lookback);
  const high20 = Math.max(...recentCandles.map(c => c.h));
  const low20 = Math.min(...recentCandles.map(c => c.l));
  const rangePct = ((high20 - low20) / low20) * 100;
  if (rangePct < 0.5) return null;

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  
  const ema5 = ema(closes, 5);
  const ema10 = ema(closes, 10);
  const ema30 = ema(closes, 30);
  
  const { hist } = calcMACD(closes);
  const currentHist = hist[hist.length - 1] || 0;
  const prevHist = hist[hist.length - 2] || 0;
  
  const atrVal = calcATR(candles, 14);
  if (!(atrVal > 0)) return null;

  let side = null;
  let reason = "";

  const isBullishTrend = ema5 > ema10 && ema10 > ema30;
  const isBullishPullback = (Math.abs(price - ema10) / ema10 < 0.002) || (Math.abs(price - ema30) / ema30 < 0.002);
  const isMacdBullish = currentHist > 0 && currentHist > prevHist;

  if (isBullishTrend && isBullishPullback && isMacdBullish) {
    side = "LONG";
    reason = `روند صعودی، پولبک به EMA، و MACD صعودی.`;
  }

  const isBearishTrend = ema5 < ema10 && ema10 < ema30;
  const isBearishPullback = (Math.abs(price - ema10) / ema10 < 0.002) || (Math.abs(price - ema30) / ema30 < 0.002);
  const isMacdBearish = currentHist < 0 && currentHist < prevHist;

  if (isBearishTrend && isBearishPullback && isMacdBearish) {
    side = "SHORT";
    reason = `روند نزولی، پولبک به EMA، و MACD نزولی.`;
  }

  if (!side) return null;

  // حد ضرر ساختاری
  let sl;
  if (side === "LONG") {
    const recentLow = Math.min(...recentCandles.map(c => c.l));
    sl = recentLow - (atrVal * 0.5);
  } else {
    const recentHigh = Math.max(...recentCandles.map(c => c.h));
    sl = recentHigh + (atrVal * 0.5);
  }
  
  return {
    engine: "ENGINE_2_CLASSIC",
    symbol,
    timeframe,
    side,
    entry: price,
    sl,
    tp: null, // خروج با سیگنال مخالف
    rr: 0,
    reason,
    candleTime: candles[candles.length - 1].t,
    timestamp: Date.now()
  };
}
