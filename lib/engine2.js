// lib/engine2.js
// Engine 2 — EMA Pullback + MACD — Timeframe: 5m ONLY

export const ENGINE2_VERSION = "3.0.3 (EMA Pullback + MACD on 5m)";

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

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

export function detectSignalEngine2(symbol, timeframe, candles) {
  if (timeframe !== "5m") return null;
  if (!Array.isArray(candles) || candles.length < 100) return null;

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];

  const ema5 = ema(closes, 5);
  const ema10 = ema(closes, 10);
  const ema30 = ema(closes, 30);
  if (!(ema5 > 0 && ema10 > 0 && ema30 > 0)) return null;

  const { hist } = calcMACD(closes);
  if (hist.length < 2) return null;
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
    reason = `5m: روند صعودی (EMA5 > EMA10 > EMA30)، پول‌بک به EMA، و MACD صعودی.`;
  }

  const isBearishTrend = ema5 < ema10 && ema10 < ema30;
  const isBearishPullback = (Math.abs(price - ema10) / ema10 < 0.002) || (Math.abs(price - ema30) / ema30 < 0.002);
  const isMacdBearish = currentHist < 0 && currentHist < prevHist;

  if (isBearishTrend && isBearishPullback && isMacdBearish) {
    side = "SHORT";
    reason = `5m: روند نزولی (EMA5 < EMA10 < EMA30)، پول‌بک به EMA، و MACD نزولی.`;
  }

  if (!side) return null;

  const slDist = atrVal * 1.5;
  const tpDist = slDist * 2.0;

  const entry = price;
  const sl = side === "LONG" ? entry - slDist : entry + slDist;
  const tp = side === "LONG" ? entry + tpDist : entry - tpDist;

  return {
    engine: "ENGINE_2_CLASSIC",
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
