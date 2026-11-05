// lib/engine2.js

export const ENGINE2_VERSION = "2.0.2 (ATR-based SL/TP)";

function ema(values, period) {
  if (values.length < period) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(closes) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  return e12 - e26;
}

// 🟢 تابع جدید: محاسبه ATR (میانگین دامنه واقعی) برای هر تایم‌فریم
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

function fmt(v, d = 2) { 
  if (v === null || v === undefined || v === "") return "—"; 
  const n = Number(v); 
  return Number.isFinite(n) ? n.toFixed(d) : "—"; 
}

export function detectSignalEngine2(symbol, timeframe, candles) {
  if (candles.length < 200) return null;

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const atrVal = calcATR(candles, 14); // محاسبه ATR

  if (!(atrVal > 0)) return null;

  const lookback = Math.min(240, candles.length);
  const recentCandles = candles.slice(-lookback);
  const high10d = Math.max(...recentCandles.map(c => c.h));
  const low10d = Math.min(...recentCandles.map(c => c.l));

  let side = null;
  let reason = "";

  if (ema20 > ema50 && rsi > 50 && macd > 0) {
    side = "LONG";
    reason = `روند صعودی (EMA20 بالاتر از EMA50)، RSI برابر ${fmt(rsi,1)} و MACD مثبت.`;
  } else if (ema20 < ema50 && rsi < 50 && macd < 0) {
    side = "SHORT";
    reason = `روند نزولی (EMA20 پایین‌تر از EMA50)، RSI برابر ${fmt(rsi,1)} و MACD منفی.`;
  }

  if (side === "LONG" && price > high10d * 0.98) {
      side = null; reason = "نزدیک به سقف ۱۰ روزه (احتمال ریزش)";
  } else if (side === "SHORT" && price < low10d * 1.02) {
      side = null; reason = "نزدیک به کف ۱۰ روزه (احتمال رشد)";
  }

  if (!side) return null;

  // 🟢 تغییرات جدید: استفاده از ATR برای محاسبه حد ضرر و حد سود
  // این کار باعث می‌شود SL و TP در تایم 15 دقیقه کوچک‌تر و در تایم 1 ساعته بزرگ‌تر باشد
  const slDist = atrVal * 2.0; // فاصله حد ضرر: ۲ برابر ATR
  const tpDist = slDist * 2.0; // فاصله حد سود: ۲ برابر حد ضرر (نسبت ۱:۲)
  
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
    candleTime: candles[candles.length - 1].t,
    timestamp: Date.now()
  };
}
