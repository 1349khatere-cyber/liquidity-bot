// @ts-nocheck
// lib/bot.js

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VERSION = "1.5.0"; // نسخه جدید با استراتژی پیشرفته
const BASE = "https://api.toobit.com";
const SCHEMA_VERSION = 6;

// ============================================================
// SECTION 1: CONFIGURATION
// ============================================================
const SYMBOLS = ["SOL-SWAP-USDT", "XRP-SWAP-USDT", "ADA-SWAP-USDT", "LINK-SWAP-USDT", "AVAX-SWAP-USDT"];
const TIMEFRAMES = ["15m", "1h"];
const SYMBOL_GROUPS = {
  "SOL-SWAP-USDT": "l1", "AVAX-SWAP-USDT": "l1", "ADA-SWAP-USDT": "l1",
  "LINK-SWAP-USDT": "defi", "XRP-SWAP-USDT": "payment"
};

const SWEEP_CONFIG = {
  swingLookback: 60, swingLeftBars: 3, swingRightBars: 3,
  minSwingAge: 5, maxSwingAge: 55,
  minSweepDepthPct: 0.08, maxSweepDepthPct: 2.0,
  requireCloseBackInside: true, sweepScanWindow: 7, 
  minSwingProminence: 0.15, sameLevelCooldownPct: 0.05
};

const SWEEP_ALERT_CONFIG = { enabled: false, symbols: SYMBOLS, timeframes: TIMEFRAMES, cooldownMinPerSetup: 180 };

const MSS_CONFIG = { enabled: true, lookbackBars: 5 };

const CONFIRMATION_CONFIG = {
  requireRejectionCandle: true, minRejectionStrength: 1,
  requireVolume: true, minVolumeMultiplier: 1.2, // افزایش حجم برای تایید قوی‌تر
  requireAdxMin: 15, strongAdxMin: 25,
  rsiOversold: 30, rsiOverbought: 70
};

const TREND_CONFIG = { enabled: true, useEma200Filter: true }; // فیلتر جدید روند

const RISK_CONFIG = { 
  atrSlMult: 0.5, minRR: 1.5, maxRR: 5.0, targetRR: 2.0, maxHoldBars: 48,
  minSlPct: 0.5, minSlAtr: 1.0  
};

const SURVIVAL_CONFIG = {
  maxConsecutiveLosses: 3, maxDailyLossR: 3, maxDailySignals: 10,
  cooldownAfterLossMin: 45, cooldownAfterConsecutiveMin: 120,
  perSymbolCooldownMin: 30, perGroupMaxOpen: 2
};

const MIN_CONFLUENCE_SCORE = 4; // افزایش حداقل امتیاز برای سیگنال‌های قوی‌تر
const TREND_TIMEFRAMES = ["15m", "1h", "4h"];
const DRIFT_PER_TF = { "5m": 0.5, "15m": 0.8, "1h": 1.5, "4h": 2.0, "1d": 3.0 };
const DRIFT_DEFAULT = 1.0;

const INTERVAL_MS = {
  "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3,
  "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "6h": 21600e3,
  "8h": 28800e3, "12h": 43200e3, "1d": 86400e3, "1w": 604800e3
};

const TRACK_CANDLE_LIMIT = 500;
const SAVE_THROTTLE_MS = 15 * 60 * 1000;

const klineCache = new Map();
const trendCache = new Map();

let __currentRejectStats = null;
function reject(reason) {
  if (__currentRejectStats) __currentRejectStats[reason] = (__currentRejectStats[reason] || 0) + 1;
  return null;
}

// ============================================================
// SECTION 2: UTILITIES
// ============================================================
function num(v, d) { if (v === undefined || v === null || v === "") return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
function intervalMs(tf) { return INTERVAL_MS[tf] || 900e3; }
function log(level, msg, extra = {}) { try { console.log(JSON.stringify({ level, msg, ts: Date.now(), ...extra })); } catch { /* ignore */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmt(v, d = 2) { if (v === null || v === undefined || v === "") return "—"; const n = Number(v); return Number.isFinite(n) ? n.toFixed(d) : "—"; }
function fmtPrice(p) { const n = Number(p); if (!Number.isFinite(n)) return "-"; const a = Math.abs(n); return n.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 10 ? 4 : a >= 1 ? 5 : 6); }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function formatTehranTime(ts) { if (!Number.isFinite(ts)) return "—"; const tehranMs = ts + (3.5 * 3600e3); const d = new Date(tehranMs); const pad = n => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }

function trendIcon(dir) { if (dir === "bull") return "🟢 صعودی"; if (dir === "bear") return "🔴 نزولی"; if (dir === "unknown") return "⚠️ نامشخص"; return "🟡 خنثی"; }
function trendShort(dir) { if (dir === "bull") return "🟢"; if (dir === "bear") return "🔴"; if (dir === "unknown") return "⚠️"; return "🟡"; }

function maxEntryDriftPct(env, timeframe) {
  const tfDefault = DRIFT_PER_TF[timeframe] ?? DRIFT_DEFAULT;
  const envVal = num(env.MAX_ENTRY_DRIFT_PCT, 0);
  return Math.max(tfDefault, envVal);
}

function cfg(env) {
  return {
    symbols: SYMBOLS, timeframes: TIMEFRAMES,
    capitalUsdt: num(env.CAPITAL_USDT, 0),
    riskPerTradePct: num(env.RISK_PER_TRADE_PCT, 1),
    tzOffsetMin: num(env.TZ_OFFSET_MIN, 210),
    maxEntryDriftPct: num(env.MAX_ENTRY_DRIFT_PCT, 1.0)
  };
}

// ============================================================
// SECTION 3: INDICATORS
// ============================================================
function emaSeries(values, period) { if (!Array.isArray(values) || period < 1 || values.length < period) return []; const k = 2 / (period + 1); let e = 0; for (let i = 0; i < period; i++) e += values[i]; e /= period; const out = [e]; for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); } return out; }
function ema(values, period) { const s = emaSeries(values, period); return s.length ? s[s.length - 1] : 0; }

function rsiSeries(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(NaN);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  const calc = () => { if (avgLoss === 0 && avgGain === 0) return 50; if (avgLoss === 0) return 100; if (avgGain === 0) return 0; return 100 - 100 / (1 + avgGain / avgLoss); };
  out[period] = calc();
  for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; const g = d > 0 ? d : 0, l = d < 0 ? -d : 0; avgGain = (avgGain * (period - 1) + g) / period; avgLoss = (avgLoss * (period - 1) + l) / period; out[i] = calc(); }
  return out;
}

function trueRange(cur, prev) { return Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)); }

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 0;
  const trs = []; for (let i = 1; i < candles.length; i++) trs.push(trueRange(candles[i], candles[i - 1]));
  let v = 0; for (let i = 0; i < period; i++) v += trs[i]; v /= period;
  for (let i = period; i < trs.length; i++) v = (v * (period - 1) + trs[i]) / period;
  return v;
}

function adx(candles, period = 14) {
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n < period * 2 + 2) return NaN;
  const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) { const up = candles[i].h - candles[i - 1].h; const down = candles[i - 1].l - candles[i].l; pdm[i] = (up > down && up > 0) ? up : 0; mdm[i] = (down > up && down > 0) ? down : 0; tr[i] = trueRange(candles[i], candles[i - 1]); }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += pdm[i]; mS += mdm[i]; }
  const dx = [];
  const computeDx = () => { if (trS === 0) return 0; const pdi = 100 * pS / trS, mdi = 100 * mS / trS, s = pdi + mdi; return s === 0 ? 0 : 100 * Math.abs(pdi - mdi) / s; };
  dx.push(computeDx());
  for (let i = period + 1; i < n; i++) { trS = trS - trS / period + tr[i]; pS = pS - pS / period + pdm[i]; mS = mS - mS / period + mdm[i]; dx.push(computeDx()); }
  if (dx.length < period) return dx.length ? dx[dx.length - 1] : NaN;
  let a = 0; for (let i = 0; i < period; i++) a += dx[i]; a /= period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
  return a;
}

function volumeMA(volumes, period = 20) { if (!Array.isArray(volumes) || volumes.length < period) return NaN; return volumes.slice(-period).reduce((a, b) => a + b, 0) / period; }
function volumeRankPercent(volumes, current) { if (!Array.isArray(volumes) || volumes.length === 0) return 0; const slice = volumes.slice(-100); const below = slice.filter(v => v < current).length; return (below / slice.length) * 100; }

function analyzeTrend(candles) {
  if (!Array.isArray(candles) || candles.length < 200) return { dir: "unknown", emaFast: 0, emaSlow: 0, ema200: 0, adx: NaN };
  const closes = candles.map(c => c.c);
  const eFast = ema(closes, 20), eSlow = ema(closes, 50), e200 = ema(closes, 200);
  const price = closes[closes.length - 1];
  let dir = "neutral";
  if (eFast > eSlow && price > eSlow) dir = "bull";
  else if (eFast < eSlow && price < eSlow) dir = "bear";
  return { dir, emaFast: eFast, emaSlow: eSlow, ema200: e200, adx: adx(candles, 14), price };
}

// ============================================================
// SECTION 4: SWING
// ============================================================
function pivotHighs(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    let isPivot = true;
    for (let j = 1; j <= left; j++) if (candles[i].h <= candles[i - j].h) { isPivot = false; break; }
    if (isPivot) for (let j = 1; j <= right; j++) if (candles[i].h <= candles[i + j].h) { isPivot = false; break; }
    if (isPivot) out.push({ i, price: candles[i].h, time: candles[i].t });
  }
  return out;
}
function pivotLows(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    let isPivot = true;
    for (let j = 1; j <= left; j++) if (candles[i].l >= candles[i - j].l) { isPivot = false; break; }
    if (isPivot) for (let j = 1; j <= right; j++) if (candles[i].l >= candles[i + j].l) { isPivot = false; break; }
    if (isPivot) out.push({ i, price: candles[i].l, time: candles[i].t });
  }
  return out;
}

function findSwingLiquidity(candles, atrVal) {
  const n = candles.length;
  if (n < SWEEP_CONFIG.swingLookback) return { swingHigh: null, swingLow: null };
  const sub = candles.slice(-SWEEP_CONFIG.swingLookback);
  const highs = pivotHighs(sub, SWEEP_CONFIG.swingLeftBars, SWEEP_CONFIG.swingRightBars);
  const lows = pivotLows(sub, SWEEP_CONFIG.swingLeftBars, SWEEP_CONFIG.swingRightBars);
  const minProm = SWEEP_CONFIG.minSwingProminence * atrVal;

  const filter = (list) => {
    const filtered = [];
    for (const p of list) {
      const age = sub.length - 1 - p.i;
      if (age < SWEEP_CONFIG.minSwingAge) continue;
      if (age > SWEEP_CONFIG.maxSwingAge) continue;
      filtered.push({ ...p, age, subIndex: p.i });
    }
    return filtered;
  };

  let bestHigh = null;
  for (const h of filter(highs)) {
    let prominent = true;
    const start = Math.max(0, h.subIndex - 5), end = Math.min(sub.length, h.subIndex + 6);
    for (let i = start; i < end; i++) { if (i === h.subIndex) continue; if (sub[i].h > h.price - minProm) { prominent = false; break; } }
    if (prominent && (!bestHigh || h.subIndex > bestHigh.subIndex)) bestHigh = h;
  }

  let bestLow = null;
  for (const l of filter(lows)) {
    let prominent = true;
    const start = Math.max(0, l.subIndex - 5), end = Math.min(sub.length, l.subIndex + 6);
    for (let i = start; i < end; i++) { if (i === l.subIndex) continue; if (sub[i].l < l.price + minProm) { prominent = false; break; } }
    if (prominent && (!bestLow || l.subIndex > bestLow.subIndex)) bestLow = l;
  }

  const offset = n - sub.length;
  return {
    swingHigh: bestHigh ? { ...bestHigh, globalIndex: offset + bestHigh.subIndex } : null,
    swingLow: bestLow ? { ...bestLow, globalIndex: offset + bestLow.subIndex } : null
  };
}

// ============================================================
// SECTION 5: PATTERNS
// ============================================================
function rejectionPatternAt(candles, index, direction) {
  if (index < 1 || index >= candles.length) return { ok: false, name: "none", strength: 0 };
  const cur = candles[index];
  const range = cur.h - cur.l;
  if (range <= 0) return { ok: false, name: "none", strength: 0 };
  const body = Math.abs(cur.c - cur.o), upperWick = cur.h - Math.max(cur.c, cur.o), lowerWick = Math.min(cur.c, cur.o) - cur.l;
  const isBullish = cur.c > cur.o, isBearish = cur.c < cur.o;

  if (direction === 1) {
    if (lowerWick > range * 0.6 && body < range * 0.35 && isBullish) return { ok: true, name: "hammer", strength: 2, farsi: "چکش" };
    if (lowerWick > range * 0.5 && body < range * 0.4) return { ok: true, name: "bullish_pin", strength: 2, farsi: "پین‌بار صعودی" };
    if (isBullish && body > range * 0.5 && cur.c > (cur.h + cur.l) / 2) return { ok: true, name: "strong_bullish", strength: 1, farsi: "کندل صعودی قوی" };
  } else if (direction === -1) {
    if (upperWick > range * 0.6 && body < range * 0.35 && isBearish) return { ok: true, name: "shooting_star", strength: 2, farsi: "ستاره ثاقب" };
    if (upperWick > range * 0.5 && body < range * 0.4) return { ok: true, name: "bearish_pin", strength: 2, farsi: "پین‌بار نزولی" };
    if (isBearish && body > range * 0.5 && cur.c < (cur.h + cur.l) / 2) return { ok: true, name: "strong_bearish", strength: 1, farsi: "کندل نزولی قوی" };
  }
  return { ok: false, name: "none", strength: 0 };
}

// ============================================================
// SECTION 6: SWEEP
// ============================================================
function detectSweep(candles, swingLevel, side, atrVal) {
  const n = candles.length;
  const scanStart = Math.max(1, n - SWEEP_CONFIG.sweepScanWindow);
  const results = [];

  for (let i = scanStart; i < n; i++) {
    const k = candles[i];
    const isLast = i === n - 1;

    if (side === "HIGH") {
      const wickPrice = k.h;
      if (wickPrice <= swingLevel.price) continue;
      const sweepDepthPct = (wickPrice - swingLevel.price) / swingLevel.price * 100;
      if (sweepDepthPct < SWEEP_CONFIG.minSweepDepthPct || sweepDepthPct > SWEEP_CONFIG.maxSweepDepthPct) continue;
      if (SWEEP_CONFIG.requireCloseBackInside && !(k.c < swingLevel.price)) continue;
      let invalidated = false;
      for (let j = i + 1; j < n; j++) if (candles[j].c > swingLevel.price + 0.1 * atrVal) { invalidated = true; break; }
      if (invalidated) continue;
      results.push({ sweepBar: i, sweepBarTime: k.t, sweepExtreme: wickPrice, sweepClose: k.c, sweepDepthPct, swingPrice: swingLevel.price, swingTime: swingLevel.time, swingAge: i - swingLevel.globalIndex, side: "HIGH", isLastBar: isLast });
    } else {
      const wickPrice = k.l;
      if (wickPrice >= swingLevel.price) continue;
      const sweepDepthPct = (swingLevel.price - wickPrice) / swingLevel.price * 100;
      if (sweepDepthPct < SWEEP_CONFIG.minSweepDepthPct || sweepDepthPct > SWEEP_CONFIG.maxSweepDepthPct) continue;
      if (SWEEP_CONFIG.requireCloseBackInside && !(k.c > swingLevel.price)) continue;
      let invalidated = false;
      for (let j = i + 1; j < n; j++) if (candles[j].c < swingLevel.price - 0.1 * atrVal) { invalidated = true; break; }
      if (invalidated) continue;
      results.push({ sweepBar: i, sweepBarTime: k.t, sweepExtreme: wickPrice, sweepClose: k.c, sweepDepthPct, swingPrice: swingLevel.price, swingTime: swingLevel.time, swingAge: i - swingLevel.globalIndex, side: "LOW", isLastBar: isLast });
    }
  }
  if (results.length === 0) return null;
  return results[results.length - 1];
}

// ============================================================
// SECTION 7: CONFLUENCE
// ============================================================
function computeConfluence(sig) {
  const details = []; let score = 0; const maxScore = 10; const isLong = sig.side === "LONG";

  const htf4h = sig.trends["4h"]?.dir || "unknown";
  if (isLong) {
    if (htf4h === "bull") { score += 2; details.push("✅ 4h صعودی (هم‌جهت)"); } else if (htf4h === "neutral") { score += 1; details.push("🟡 4h خنثی"); } else if (htf4h === "unknown") { score += 1; details.push("⚠️ 4h نامشخص"); } else details.push("⚠️ 4h نزولی (خلاف روند)");
  } else {
    if (htf4h === "bear") { score += 2; details.push("✅ 4h نزولی (هم‌جهت)"); } else if (htf4h === "neutral") { score += 1; details.push("🟡 4h خنثی"); } else if (htf4h === "unknown") { score += 1; details.push("⚠️ 4h نامشخص"); } else details.push("⚠️ 4h صعودی (خلاف روند)");
  }

  if (sig.pattern?.ok) {
    if (sig.pattern.strength >= 2) { score += 2; details.push(`✅ الگوی برگشت قوی (${sig.pattern.farsi})`); } else { score += 1; details.push(`✅ الگوی برگشت ضعیف (${sig.pattern.farsi})`); }
  } else details.push("❌ الگوی برگشت ندارد");

  const volStrong = sig.volRatio >= 1.5;
  const volOk = sig.volRatio >= 1.2;
  if (volStrong) { score += 2; details.push(`✅ حجم قوی (${fmt(sig.volRatio, 2)}x)`); } else if (volOk) { score += 1; details.push(`✅ حجم متوسط (${fmt(sig.volRatio, 2)}x)`); } else details.push(`❌ حجم کم (${fmt(sig.volRatio, 2)}x)`);

  if (Number.isFinite(sig.adx) && sig.adx >= 25) { score += 1; details.push(`✅ ADX قوی (${fmt(sig.adx, 1)})`); } else if (Number.isFinite(sig.adx) && sig.adx >= 15) { details.push(`🟡 ADX متوسط (${fmt(sig.adx, 1)})`); } else details.push(`❌ ADX ضعیف (${fmt(sig.adx, 1)})`);

  if (isLong) {
    if (sig.rsi <= 35) { score += 1; details.push(`✅ RSI اشباع فروش (${fmt(sig.rsi, 1)})`); } else if (sig.rsi <= 45) { score += 1; details.push(`✅ RSI پایین (${fmt(sig.rsi, 1)})`); } else details.push(`🟡 RSI خنثی (${fmt(sig.rsi, 1)})`);
  } else {
    if (sig.rsi >= 65) { score += 1; details.push(`✅ RSI اشباع خرید (${fmt(sig.rsi, 1)})`); } else if (sig.rsi >= 55) { score += 1; details.push(`✅ RSI بالا (${fmt(sig.rsi, 1)})`); } else details.push(`🟡 RSI خنثی (${fmt(sig.rsi, 1)})`);
  }

  const dep = sig.sweep.sweepDepthPct;
  if (dep >= 0.1 && dep <= 0.8) { score += 1; details.push(`✅ عمق شکار ایده‌آل (${fmt(dep, 3)}%)`); } else if (dep > 0.8) { score += 1; details.push(`✅ شکار عمیق (${fmt(dep, 3)}%)`); } else details.push(`🟡 شکار کم‌عمق (${fmt(dep, 3)}%)`);

  if (sig.sweep.isLastBar) { score += 1; details.push("✅ شکار در کندل اخیر"); }

  let label = "🔴 ضعیف";
  if (score >= 8) label = "🟢 عالی"; else if (score >= 6) label = "🟢 خوب"; else if (score >= 4) label = "🟡 متوسط"; else if (score >= 3) label = "🟡 قابل قبول";

  return { score, maxScore, label, details };
}

// ============================================================
// SECTION 8: TP/SL
// ============================================================
function calcTpSl(side, entry, sweep, atrVal, swingHigh, swingLow) {
  const buffer = RISK_CONFIG.atrSlMult * atrVal;
  let sl, tp, rr, tpSource = "fallback_targetRR", risk;

  if (side === "LONG") {
    sl = sweep.sweepExtreme - buffer;
    risk = entry - sl;
    if (risk <= 0) return null;
    if (swingHigh && swingHigh.price > entry) {
      const structRr = (swingHigh.price - entry) / risk;
      if (structRr >= RISK_CONFIG.minRR && structRr <= RISK_CONFIG.maxRR) { tp = swingHigh.price; tpSource = "structure_swingHigh"; }
    }
    if (!tp) tp = entry + RISK_CONFIG.targetRR * risk;
    rr = (tp - entry) / risk;
  } else {
    sl = sweep.sweepExtreme + buffer;
    risk = sl - entry;
    if (risk <= 0) return null;
    if (swingLow && swingLow.price < entry) {
      const structRr = (entry - swingLow.price) / risk;
      if (structRr >= RISK_CONFIG.minRR && structRr <= RISK_CONFIG.maxRR) { tp = swingLow.price; tpSource = "structure_swingLow"; }
    }
    if (!tp) tp = entry - RISK_CONFIG.targetRR * risk;
    rr = (entry - tp) / risk;
  }
  return { sl, tp, rr, risk: Math.abs(entry - sl), tpSource };
}

// ============================================================
// SECTION 9: API
// ============================================================
async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal });
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; throw err; }
    const data = await res.json();
    if (data && typeof data === "object" && !Array.isArray(data) && data.code !== undefined && data.code !== 0 && data.code !== 200) {
      const err = new Error(`Toobit API Error: ${data.code} - ${data.msg || 'Unknown'}`);
      err.status = 400;
      throw err;
    }
    return data;
  } finally { clearTimeout(timer); }
}

async function publicGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetchJson(url.toString(), { headers: { accept: "application/json" } }, 5000); }
    catch (e) { lastErr = e; const retryable = e.status === undefined || e.status === 429 || e.status >= 500; if (!retryable || attempt === 2) break; await sleep(300 * Math.pow(2, attempt)); }
  }
  throw new Error(`Toobit ${path}: ${lastErr?.message || lastErr}`);
}

async function getKlines(symbol, interval, limit = 200, startTime = null) {
  const cacheKey = `${symbol}_${interval}_${limit}_${startTime}`;
  if (klineCache.has(cacheKey)) return klineCache.get(cacheKey);

  const params = { symbol, interval, limit };
  if (startTime !== null) params.startTime = startTime;
  const raw = await publicGet("/quote/v1/klines", params);
  if (!Array.isArray(raw)) throw new Error("bad_klines");
  const ms = intervalMs(interval), now = Date.now();
  const out = [];
  for (const x of raw) {
    if (!Array.isArray(x)) continue;
    const k = { t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) };
    if (![k.t, k.o, k.h, k.l, k.c, k.v].every(Number.isFinite)) continue;
    if (k.t + ms <= now) out.push(k);
  }
  out.sort((a, b) => a.t - b.t);
  klineCache.set(cacheKey, out);
  return out;
}

async function getLivePrice(symbol) {
  try {
    const raw = await publicGet("/quote/v1/ticker/24hr", { symbol });
    const item = Array.isArray(raw) ? raw[0] : raw;
    const price = Number(item?.lastPrice ?? item?.last ?? item?.price ?? item?.c ?? 0);
    if (Number.isFinite(price) && price > 0) return price;
  } catch (e) { log("warn", "live_price_err", { symbol, err: e.message }); }
  return null;
}

async function getTrendsCached(symbol, timeframe, closedCandles, now, tfs) {
  const key = `${symbol}_${timeframe}_${tfs.join("_")}`;
  if (trendCache.has(key)) return trendCache.get(key);
  const trends = {};
  for (const tf of tfs) {
    try {
      if (tf === timeframe) trends[tf] = analyzeTrend(closedCandles);
      else {
        const tfCandles = await getKlines(symbol, tf, 200); // افزایش به 200 برای EMA200
        const tfClosed = tfCandles.filter(c => c.t + intervalMs(tf) + 5000 <= now);
        trends[tf] = analyzeTrend(tfClosed);
      }
    } catch (e) { trends[tf] = { dir: "unknown" }; }
    await sleep(80);
  }
  trendCache.set(key, trends);
  return trends;
}

// ============================================================
// SECTION 10: SIGNAL DETECTION
// ============================================================
async function detectSignal(symbol, timeframe, candles, env) {
  const now = Date.now();
  const closed = candles.filter(k => k.t + intervalMs(timeframe) <= now);
  if (closed.length < 100) return reject("detect_not_enough_candles");

  const allCloses = closed.map(k => k.c);
  const atrVal = atr(closed, 14);
  if (!(atrVal > 0)) return reject("detect_atr_invalid");

  const trends = await getTrendsCached(symbol, timeframe, closed, now, TREND_TIMEFRAMES);

  const { swingHigh, swingLow } = findSwingLiquidity(closed, atrVal);
  if (!swingHigh && !swingLow) return reject("detect_no_swings");

  const sweepHigh = swingHigh ? detectSweep(closed, swingHigh, "HIGH", atrVal) : null;
  const sweepLow = swingLow ? detectSweep(closed, swingLow, "LOW", atrVal) : null;

  let sweep = null, side = null;
  if (sweepHigh && sweepLow) {
    if (sweepHigh.sweepBar > sweepLow.sweepBar) { sweep = sweepHigh; side = "SHORT"; } else { sweep = sweepLow; side = "LONG"; }
  } else if (sweepHigh) { sweep = sweepHigh; side = "SHORT"; }
  else if (sweepLow) { sweep = sweepLow; side = "LONG"; }
  else return reject("detect_no_sweep");

  // فیلتر روند (EMA200)
  if (TREND_CONFIG.enabled && TREND_CONFIG.useEma200Filter) {
    const e200 = trends[timeframe]?.ema200;
    if (Number.isFinite(e200)) {
      if (side === "LONG" && closed[closed.length - 1].c < e200) return reject("detect_ema200_blocked");
      if (side === "SHORT" && closed[closed.length - 1].c > e200) return reject("detect_ema200_blocked");
    }
  }

  if (TREND_CONFIG.enabled) {
    let htfDir = trends["4h"]?.dir;
    if (htfDir !== "bull" && htfDir !== "bear" && TREND_CONFIG.use1hFallback) htfDir = trends["1h"]?.dir;
    if (side === "LONG" && htfDir === "bear") return reject("detect_trend_filter_blocked");
    if (side === "SHORT" && htfDir === "bull") return reject("detect_trend_filter_blocked");
  }

  const sweepBar = sweep.sweepBar;
  if (MSS_CONFIG.enabled) {
    if (sweepBar >= closed.length - 1) return reject("detect_sweep_on_last_bar");
    let mssConfirmed = false;
    const preSweep = closed.slice(Math.max(0, sweepBar - MSS_CONFIG.lookbackBars), sweepBar);
    if (side === "LONG") {
      const localHigh = Math.max(...preSweep.map(c => c.h));
      mssConfirmed = closed.slice(sweepBar + 1).some(c => c.c > localHigh);
    } else {
      const localLow = Math.min(...preSweep.map(c => c.l));
      mssConfirmed = closed.slice(sweepBar + 1).some(c => c.c < localLow);
    }
    if (!mssConfirmed) return reject("detect_no_mss");
  }

  const direction = side === "LONG" ? 1 : -1;
  const confirmCandle = closed[closed.length - 1];
  const confirmIndex = closed.length - 1;

  const rsiArr = rsiSeries(allCloses, 14);
  const rsi = rsiArr.length ? rsiArr[confirmIndex] : NaN;
  const adxVal = adx(closed, 14);
  if (!Number.isFinite(adxVal) || adxVal < CONFIRMATION_CONFIG.requireAdxMin) return reject("detect_adx_low");

  const vols = closed.map(k => k.v);
  const priorVols = vols.slice(0, confirmIndex);
  const volMA20 = volumeMA(priorVols, 20);
  const volRatio = volMA20 > 0 ? confirmCandle.v / volMA20 : 1;
  const volRank = volumeRankPercent(priorVols, confirmCandle.v);
  if (CONFIRMATION_CONFIG.requireVolume && volRatio < CONFIRMATION_CONFIG.minVolumeMultiplier) return reject("detect_volume_low");

  const pat = rejectionPatternAt(closed, confirmIndex, direction);
  if (CONFIRMATION_CONFIG.requireRejectionCandle && (!pat.ok || pat.strength < CONFIRMATION_CONFIG.minRejectionStrength)) return reject("detect_no_rejection");

  const tempSig = { side, trends, adx: adxVal, rsi, volRatio, sweep, pattern: pat };
  const confluence = computeConfluence(tempSig);
  if (confluence.score < MIN_CONFLUENCE_SCORE) return reject("detect_low_score");

  const livePrice = await getLivePrice(symbol);
  const refPrice = (livePrice !== null && livePrice > 0) ? livePrice : confirmCandle.c;
  const driftPct = Math.abs(refPrice - confirmCandle.c) / confirmCandle.c * 100;
  const driftMax = maxEntryDriftPct(env, timeframe);
  if (driftPct > driftMax) return reject("detect_entry_drift");

  const entry = refPrice;
  const tpSl = calcTpSl(side, entry, sweep, atrVal, swingHigh, swingLow);
  if (!tpSl || tpSl.rr < RISK_CONFIG.minRR || tpSl.rr > RISK_CONFIG.maxRR) return reject("detect_invalid_tpsl");

  const slPct = (tpSl.risk / entry) * 100;
  if (slPct < RISK_CONFIG.minSlPct) return reject("detect_sl_too_tight");
  const slAtrDist = tpSl.risk / atrVal;
  if (slAtrDist < RISK_CONFIG.minSlAtr) return reject("detect_sl_below_atr");

  return {
    symbol, timeframe, side, direction, candleTime: confirmCandle.t, price: entry,
    entry, sl: tpSl.sl, tp: tpSl.tp, slDist: tpSl.risk, rr: tpSl.rr, tpSource: tpSl.tpSource,
    sweep, sweepIsLastBar: false, rsi: Number.isFinite(rsi) ? rsi : null,
    adx: Number.isFinite(adxVal) ? adxVal : null, volRatio, volRank, pattern: pat, trends,
    atr: atrVal, confluence, lastCandleT: confirmCandle.t
  };
}

// ============================================================
// SECTION 13: KV STORAGE
// ============================================================
async function kvGet(key, fallback = null) {
  try {
    const value = await redis.get(key);
    if (value === null || value === undefined) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (e) {
    log("warn", "redis_get_err", { key, err: e.message });
    return fallback;
  }
}

async function kvPut(key, value) {
  try { await redis.set(key, JSON.stringify(value)); } 
  catch (e) { log("warn", "redis_put_err", { key, err: e.message }); }
}

const _saveTimers = {};
async function kvPutThrottled(key, value, force = false) {
  const now = Date.now();
  const last = _saveTimers[key] || 0;
  if (!force && now - last < SAVE_THROTTLE_MS) return;
  _saveTimers[key] = now;
  try { await redis.set(key, JSON.stringify(value)); }
  catch (e) { log("warn", "redis_put_throttled_err", { key, err: e.message }); }
}

async function acquireLock(now) {
  const lockKey = "run_lock";
  try {
    const existing = await kvGet(lockKey, null);
    if (existing && existing.expiresAt > now) return { acquired: false, existing };
    const token = crypto.randomUUID();
    await kvPut(lockKey, { token, acquiredAt: now, expiresAt: now + 2 * 60e3 });
    return { acquired: true, token };
  } catch (e) { return { acquired: true, token: null }; }
}
async function releaseLock(token) {
  if (!token) return;
  try {
    const existing = await kvGet("run_lock", null);
    if (existing && existing.token === token) await redis.del("run_lock");
  } catch (e) { /* ignore */ }
}

// ============================================================
// SECTION 14: STATE
// ============================================================
function initialState() {
  return {
    schema: SCHEMA_VERSION, version: VERSION, paused: false, pausedReason: "",
    lastSignals: {}, lastRun: 0, lastSignalAt: 0, lastSignalCount: 0,
    dailyR: 0, dailyKey: "", dailySignalsCount: 0, consecutiveLosses: 0,
    dailyLossBlockUntil: 0, gateStats: {}
  };
}

async function loadState() {
  const raw = await kvGet("STATE", {});
  const state = { ...initialState(), ...(raw || {}) };
  if (!state.gateStats || typeof state.gateStats !== "object") state.gateStats = {};
  state.version = VERSION;
  return state;
}

async function saveState(state, force = false) {
  await kvPutThrottled("STATE", state, force);
}

// ============================================================
// SECTION 15: TRADE TRACKING
// ============================================================
function buildCloseMessage(sg, exitPrice, status, R, closedAt, source) {
  const icon = status === "TP" ? "✅" : status === "SL" ? "🛑" : status === "VOID" ? "⚪" : "⏱";
  const label = status === "TP" ? "حد سود لمس شد" : status === "SL" ? "حد ضرر لمس شد" : status === "VOID" ? "باطل شد" : "زمان تمام شد";
  const sourceTag = source ? ` (${source})` : "";
  const isLong = sg.side === "LONG";
  const sideFa = isLong ? "🟢 خرید (LONG)" : "🔴 فروش (SHORT)";
  const signalDate = formatTehranTime((sg.candleTime || 0) + intervalMs(sg.timeframe));
  const topTime = formatTehranTime(Number.isFinite(closedAt) ? closedAt : Date.now());
  
  const msgBody = [
    `<b>${icon} ${esc(sg.symbol)}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;| ${sg.timeframe}</b>`,
    `📅 ${topTime}`,
    `────────────────────`,
    `────────────────────`,
    `🔢 شماره سیگنال: #${sg.signalId || "—"}`,
    `📅 ${signalDate}`,
    `🎯 جهت: ${sideFa}`,
    `────────────────────`,
    `<b>📊 نتیجه معامله:</b>`,
    `   ${label}${sourceTag}`,
    Number.isFinite(R) ? `   📉 <b>نتیجه: ${R.toFixed(2)}R</b>` : "",
    `────────────────────`,
    `💰 <b>ورود بود:</b> <code>${fmtPrice(sg.entry)}</code>`,
    `🚪 <b>خروج:</b> <code>${fmtPrice(exitPrice)}</code>`
  ].filter(Boolean).join("\n");
  return `<blockquote>${msgBody}</blockquote>`;
}

function closeSignal(sg, status, R, k, exitPrice, extra = {}) {
  const rFin = Number.isFinite(R);
  return { ...sg, ...extra, status, R: rFin ? Number(R.toFixed(3)) : null, exitPrice, closedAt: k ? k.t + intervalMs(sg.timeframe) : Date.now() };
}

function updateSignal(sg, candlesTrack, now) {
  const tfMs = intervalMs(sg.timeframe);
  const expiryAt = sg.sentAt + RISK_CONFIG.maxHoldBars * tfMs;
  const isLong = sg.side === "LONG";
  const ds = isLong ? 1 : -1;
  const slDist = sg.slDist > 0 ? sg.slDist : 1e-9;
  const maxStep = tfMs * 2;

  const fresh = candlesTrack.filter(k => k.t > sg.lastT).sort((a, b) => a.t - b.t);
  for (const k of fresh) {
    if (k.t > expiryAt) break;
    if (k.t - sg.lastT > maxStep) return closeSignal(sg, "VOID", NaN, null, null, { voidReason: "candle_gap" });
    sg.lastT = k.t; sg.lastClose = k.c;
    const hitSL = isLong ? k.l <= sg.sl : k.h >= sg.sl;
    const hitTP = isLong ? k.h >= sg.tp : k.l <= sg.tp;
    if (hitSL && hitTP) return closeSignal(sg, "VOID", NaN, null, null, { voidReason: "ambiguous" });
    if (hitSL) return closeSignal(sg, "SL", -1, k, sg.sl);
    if (hitTP) return closeSignal(sg, "TP", sg.rr, k, sg.tp);
  }

  if (now >= expiryAt) {
    if (Number.isFinite(sg.lastClose)) {
      const R = ((sg.lastClose - sg.entry) * ds) / slDist;
      return closeSignal(sg, "EXPIRED", R, { t: sg.lastT }, sg.lastClose);
    }
    return closeSignal(sg, "VOID", NaN, null, null, { voidReason: "no_data" });
  }
  return null;
}

// ============================================================
// SECTION 16: STATISTICS
// ============================================================
function computeStats(closed) {
  const valid = closed.filter(t => t.status !== "VOID" && Number.isFinite(t.R));
  const n = valid.length;
  if (n === 0) return { n: 0, wins: 0, losses: 0, expired: 0, winRate: 0, expectancy: 0, totalR: 0, avgR: 0, bestR: 0, worstR: 0, maxDD: 0, profitFactor: 0, ci95: NaN, bySide: {}, byScore: {} };

  const wins = valid.filter(t => t.R > 0).length;
  const losses = valid.filter(t => t.R < 0).length;
  const expired = valid.filter(t => t.status === "EXPIRED").length;
  const totalR = valid.reduce((a, b) => a + b.R, 0);
  const meanR = totalR / n;
  const variance = valid.reduce((a, b) => a + (b.R - meanR) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  const se = n > 1 ? sd / Math.sqrt(n) : NaN;
  const ci95 = Number.isFinite(se) ? 1.96 * se : NaN;

  const grossWin = valid.filter(t => t.R > 0).reduce((a, b) => a + b.R, 0);
  const grossLoss = Math.abs(valid.filter(t => t.R < 0).reduce((a, b) => a + b.R, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  let peak = 0, dd = 0, cum = 0;
  for (const t of valid) { cum += t.R; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }

  const bySide = {}, byScore = {};
  for (const t of valid) {
    const sk = t.side || "?";
    (bySide[sk] ||= { n: 0, wins: 0, totalR: 0, avgR: 0 }); bySide[sk].n++;
    if (t.R > 0) bySide[sk].wins++;
    bySide[sk].totalR += t.R;
    const scoreKey = String(t.confluence?.score ?? "?");
    (byScore[scoreKey] ||= { n: 0, wins: 0, totalR: 0 }); byScore[scoreKey].n++;
    if (t.R > 0) byScore[scoreKey].wins++;
    byScore[scoreKey].totalR += t.R;
  }
  for (const k of Object.keys(bySide)) bySide[k].avgR = bySide[k].totalR / bySide[k].n;

  return { n, wins, losses, expired, winRate: n > 0 ? wins / n : 0, expectancy: meanR, totalR, avgR: meanR, bestR: Math.max(...valid.map(t => t.R)), worstR: Math.min(...valid.map(t => t.R)), maxDD: dd, profitFactor: pf, ci95, bySide, byScore };
}

// ============================================================
// SECTION 17: EXPORTS
// ============================================================
export async function trackOpenTrades(env, paused = false) {
  const trades = await kvGet("TRADES", { open: [], closed: [] });
  if (!Array.isArray(trades.open)) trades.open = [];
  if (!Array.isArray(trades.closed)) trades.closed = [];
  if (!trades.open.length) return { trades, closed: [] };

  const now = Date.now();
  const stillOpen = [], closed = [];

  for (const sg of trades.open) {
    try {
      if (sg.pendingClose) {
        const pc = sg.pendingClose;
        const newMsg = buildCloseMessage(sg, pc.exitPrice, pc.status, pc.R, pc.closedAt, "Emergency");
        const ok = await sendTelegram(env, newMsg);
        if (ok) {
          closed.push({ ...sg, status: pc.status, R: pc.R, exitPrice: pc.exitPrice, closedAt: pc.closedAt, closeSource: "Emergency", pendingClose: undefined, closeAttempts: undefined });
        } else {
          sg.closeAttempts = (sg.closeAttempts || 0) + 1;
          sg.pendingClose.msg = newMsg;
          if (sg.closeAttempts < 5) stillOpen.push(sg);
          else closed.push({ ...sg, status: pc.status, R: pc.R, exitPrice: pc.exitPrice, closedAt: pc.closedAt, closeSource: "Emergency", pendingClose: undefined, closeAttempts: undefined });
        }
        continue;
      }

      let liveStatus = null, liveExitPrice = null;
      const livePrice = await getLivePrice(sg.symbol);
      if (livePrice) {
        const isLong = sg.side === "LONG";
        const hitSL_live = isLong ? livePrice <= sg.sl : livePrice >= sg.sl;
        const hitTP_live = isLong ? livePrice >= sg.tp : livePrice <= sg.tp;
        if (hitSL_live) { liveStatus = "SL"; liveExitPrice = sg.sl; }
        else if (hitTP_live) { liveStatus = "TP"; liveExitPrice = sg.tp; }
      }

      if (liveStatus) {
        const R = liveStatus === "TP" ? sg.rr : -1;
        const finalTrade = closeSignal(sg, liveStatus, R, { t: now }, liveExitPrice);
        finalTrade.closeSource = "Live";
        const msg = buildCloseMessage(sg, liveExitPrice, liveStatus, R, now, "Live");
        const ok = await sendTelegram(env, msg + (paused ? "\n🔔 <i>(Pause)</i>" : ""));
        if (!ok) {
          sg.pendingClose = { exitPrice: liveExitPrice, status: liveStatus, R, closedAt: now, msg };
          sg.closeAttempts = 1;
          stillOpen.push(sg);
          continue;
        }
        closed.push(finalTrade);
        continue;
      }

      const limit = Math.min(TRACK_CANDLE_LIMIT, Math.ceil((now - sg.lastT) / intervalMs(sg.timeframe)) + 5);
      const k = await getKlines(sg.symbol, sg.timeframe, limit, sg.lastT);
      const upd = updateSignal(sg, k, now);

      if (upd) {
        upd.closeSource = "Candle";
        const msg = buildCloseMessage(upd, upd.exitPrice, upd.status, upd.R, now, "Candle");
        const ok = await sendTelegram(env, msg + (paused ? "\n🔔 <i>(Pause)</i>" : ""));
        if (!ok) {
          upd.pendingClose = { exitPrice: upd.exitPrice, status: upd.status, R: upd.R, closedAt: now, msg };
          upd.closeAttempts = 1;
          stillOpen.push(upd);
          continue;
        }
        closed.push(upd);
      } else {
        stillOpen.push(sg);
      }
    } catch (e) {
      log("warn", "track_err", { symbol: sg.symbol, err: e.message });
      stillOpen.push(sg);
    }
  }

  trades.open = stillOpen;
  if (closed.length > 0) trades.closed = [...trades.closed, ...closed].slice(-300);
  await kvPutThrottled("TRADES", trades, closed.length > 0);
  return { trades, closed };
}

async function tryTgSend(url, payload) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { log("warn", "tg_reject", { status: res.status }); }
    return res.ok;
  } catch (e) { return false; }
}

export async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN, chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const okHtml = await tryTgSend(url, { chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true });
  if (okHtml) return true;
  const plain = String(text).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").slice(0, 4000);
  return await tryTgSend(url, { chat_id: chatId, text: plain, disable_web_page_preview: true });
}

export function signalMessage(sig, c, signalId) {
  const isLong = sig.side === "LONG";
  const icon = isLong ? "🟢" : "🔴";
  const sideFa = isLong ? "خرید (LONG)" : "فروش (SHORT)";
  const sweepLevel = isLong ? "کف" : "سقف";
  const sweepIcon = isLong ? "🔺" : "🔻";
  const dt = formatTehranTime(sig.candleTime + intervalMs(sig.timeframe));

  const trendLines = [];
  for (const [tf, t] of Object.entries(sig.trends)) trendLines.push(`${tf}: ${trendShort(t.dir)}`);
  const trendLineStr = trendLines.join("  |  ");

  const conf = sig.confluence || { score: 0, maxScore: 10, label: "—", details: [] };
  const confDetails = conf.details.map(d => `   ${d}`).join("\n");
  const tpSourceFa = sig.tpSource === "fallback_targetRR" ? "پایه (2R)" : (sig.tpSource || "").startsWith("structure_") ? "ساختار بازار" : "—";

  const lines = [
    `${icon} <b>${sig.symbol}</b> | TF: <b>${sig.timeframe}</b>`,
    `📅 ${dt}`,
    `🔢 <b>شماره سیگنال:</b> #${signalId}`,
    `────────────────────`,
    `📊 <b>شرایط بازار:</b>`,
    `   🎯 جهت: ${sideFa} ${icon}`,
    `   <b>${trendLineStr}</b>`,
    `────────────────────`,
    `${sweepIcon} <b>استاپ‌های شکار شده:</b>`,
    `   ${sweepLevel} قبلی: <code>${fmtPrice(sig.sweep.swingPrice)}</code>`,
    `   سایه‌ی نفوذ: <code>${fmtPrice(sig.sweep.sweepExtreme)}</code>`,
    `   عمق شکار: <b>${fmt(sig.sweep.sweepDepthPct, 3)}%</b>`,
    `────────────────────`,
    `🟢 <b>ورود:</b> <code>${fmtPrice(sig.entry)}</code>`,
    `🛑 <b>حد ضرر:</b> <code>${fmtPrice(sig.sl)}</code> (${fmt(sig.slDist / sig.entry * 100, 2)}%)`,
    `🎯 <b>حد سود:</b> <code>${fmtPrice(sig.tp)}</code> (منبع: ${tpSourceFa})`,
    `📈 <b>R:R:</b> <code>1:${fmt(sig.rr, 2)}</code>`,
    `────────────────────`,
    `🎯 <b>امتیاز اجماع: ${conf.score}/${conf.maxScore} (${conf.label})</b>`,
    confDetails,
    `────────────────────`,
    `📐 <b>جزئیات:</b>`,
    `   📊 RSI: ${fmt(sig.rsi, 1)} | ADX: ${fmt(sig.adx, 1)} | Vol: ${fmt(sig.volRatio, 2)}x`,
    sig.pattern?.ok ? `   🕯 الگو برگشت: ${esc(sig.pattern.farsi)}` : "",
    `⏰ ${dt}`,
    `<i>v${VERSION}</i>`
  ].filter(Boolean);

  return lines.join("\n");
}

export {
  cfg, getKlines, detectSignal, loadState, saveState, kvGet, kvPut, kvPutThrottled,
  acquireLock, releaseLock, computeStats, intervalMs, fmt, fmtPrice, esc,
  formatTehranTime, VERSION, SYMBOL_GROUPS, SURVIVAL_CONFIG, SWEEP_CONFIG,
  CONFIRMATION_CONFIG, TREND_CONFIG, MSS_CONFIG, RISK_CONFIG, MIN_CONFLUENCE_SCORE
};
