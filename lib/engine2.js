// lib/engine2.js

export const ENGINE2_VERSION = "3.1.0 (EMA Pullback + MACD + RSI + Volume)";

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

// 🟢 فیلتر جدید: محاسبه RSI
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  const calc = () => {
    if (avgLoss === 0 && avgGain === 0) return 50;
    if (avgLoss === 0) return 100;
    if (avgGain === 0) return 0;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  return calc();
}

export function detectSignalEngine2(symbol, timeframe, candles) {
  if (timeframe !== "5m") return null;
  if (candles.length < 100) return null;

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  const lastCandle = candles[candles.length - 1];
  
  const ema5 = ema(closes, 5);
  const ema10 = ema(closes, 10);
  const ema30 = ema(closes, 30);
  
  const { hist } = calcMACD(closes);
  const currentHist = hist[hist.length - 1] || 0;
  const prevHist = hist[hist.length - 2] || 0;
  
  const atrVal = calcATR(candles, 14);
  if (!(atrVal > 0)) return null;

  // 🟢 فیلترهای جدید
  const rsiVal = calcRSI(closes, 14);
  
  // میانگین حجم 20 کندل اخیر (بدون احتساب کندل فعلی)
  const recentVols = candles.slice(-21, -1).map(c => c.v);
  const volMA = recentVols.reduce((a, b) => a + b, 0) / 20;
  const isVolumeEnough = lastCandle.v > volMA; // حجم کندل فعلی باید بیشتر از میانگین باشد

  let side = null;
  let reason = "";

  // شرایط خرید (LONG)
  const isBullishTrend = ema5 > ema10 && ema10 > ema30;
  const isBullishPullback = (Math.abs(price - ema10) / ema10 < 0.002) || (Math.abs(price - ema30) / ema30 < 0.002);
  const isMacdBullish = currentHist > 0 && currentHist > prevHist;
  const isRsiBullish = rsiVal >= 45 && rsiVal <= 70; // نه اشباع خرید، نه خیلی ضعیف
  const isBullishCandle = lastCandle.c > lastCandle.o; // کندل باید سبز باشد

  if (isBullishTrend && isBullishPullback && isMacdBullish && isRsiBullish && isVolumeEnough && isBullishCandle) {
    side = "LONG";
    reason = `روند صعودی (EMA)، پولبک، MACD صعودی، RSI=${rsiVal.toFixed(1)}، تایید حجم و کندل صعودی.`;
  }

  // شرایط فروش (SHORT)
  const isBearishTrend = ema5 < ema10 && ema10 < ema30;
  const isBearishPullback = (Math.abs(price - ema10) / ema10 < 0.002) || (Math.abs(price - ema30) / ema30 < 0.002);
  const isMacdBearish = currentHist < 0 && currentHist < prevHist;
  const isRsiBearish = rsiVal >= 30 && rsiVal <= 55; // نه اشباع فروش، نه خیلی قوی
  const isBearishCandle = lastCandle.c < lastCandle.o; // کندل باید قرمز باشد

  if (isBearishTrend && isBearishPullback && isMacdBearish && isRsiBearish && isVolumeEnough && isBearishCandle) {
    side = "SHORT";
    reason = `روند نزولی (EMA)، پولبک، MACD نزولی، RSI=${rsiVal.toFixed(1)}، تایید حجم و کندل نزولی.`;
  }

  if (!side) return null;

  // محاسبه SL و TP بر اساس ATR
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
    rr: 2.0,
    reason,
    candleTime: lastCandle.t,
    timestamp: Date.now()
  };
}
