// @ts-nocheck
// lib/bot.js
// v1.7.7 — Engine 1 strategy UNCHANGED. Only bug fixes applied.
// Fixes:
//  1) TREND_CONFIG.use1hFallback (بود undefined)
//  2) computeConfluence.maxScore = 12 (بود 10 غیرقابل‌دسترسی)
//  3) checkToxicFlow — حذف کندل جاری از MA
//  4) acquireLock — SET NX اتمیک Upstash
//  5) lastRun همیشه persist می‌شود (force save)
//  6) TELEGRAM_CHAT_ID اجباری (نبود = ربات قفل)
//  7) crypto.randomUUID fallback
//  8) runScan — رفع Double-Count در position limit + Engine 2 limit checks
//  9) Engine 2 signals slDist و ثبت فوری در TRADES

import { Redis } from '@upstash/redis';
import { detectSignalEngine2, ENGINE2_VERSION } from './engine2.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VERSION = "1.7.7 (Active Engine 2)"; 
const BASE = "https://api.toobit.com";
const SCHEMA_VERSION = 6;

const SYMBOLS = ["SOL-SWAP-USDT", "XRP-SWAP-USDT", "ADA-SWAP-USDT", "LINK-SWAP-USDT", "AVAX-SWAP-USDT"];
const TIMEFRAMES = ["15m", "1h"];
const TIMEFRAMES_ENGINE2 = ["5m"]; 
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
  requireVolume: true, minVolumeMultiplier: 1.0, strongVolumeMultiplier: 1.5,
  requireAdxMin: 18, strongAdxMin: 25,
  rsiOversold: 30, rsiOverbought: 70
};

// ✅ BUGFIX #1: use1hFallback که در کد استفاده می‌شد ولی تعریف نشده بود
const TREND_CONFIG = { enabled: true, useEma200Filter: true, use1hFallback: true };

const RISK_CONFIG = { 
  atrSlMult: 0.5, minRR: 1.5, maxRR: 5.0, targetRR: 2.0, maxHoldBars: 48,
  minSlPct: 0.5, minSlAtr: 1.0,
  maxKellyRiskPct: 2.0 
};

const SURVIVAL_CONFIG = {
  maxConsecutiveLosses: 3, maxDailyLossR: 3, maxDailySignals: 10,
  cooldownAfterLossMin: 45, cooldownAfterConsecutiveMin: 120,
  perSymbolCooldownMin: 30, perGroupMaxOpen: 2
};

const MIN_CONFLUENCE_SCORE = 3;
const TREND_TIMEFRAMES = ["15m", "1h", "4h"];
const DRIFT_PER_TF = { "5m": 0.5, "15m": 0.8, "1h": 1.5, "4h": 2.0, "1d": 3.0 };
const DRIFT_DEFAULT = 1.0;

const INTERVAL_MS = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "6h": 21600e3, "8h": 28800e3, "12h": 43200e3, "1d": 86400e3, "1w": 604800e3 };

const TRACK_CANDLE_LIMIT = 500;
const SAVE_THROTTLE_MS = 15 * 60 * 1000;
const klineCache = new Map();
const trendCache = new Map();
let __currentRejectStats = null;

// ✅ BUGFIX #7: fallback برای محیط‌هایی که crypto.randomUUID ندارند
function genUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch (_) { /* ignore */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function reject(reason) {
  if (__currentRejectStats) __currentRejectStats[reason] = (__currentRejectStats[reason] || 0) + 1;
  return null;
}

function num(v, d) { if (v === undefined || v === null || v === "") return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
function intervalMs(tf) { return INTERVAL_MS[tf] || 900e3; }
function log(level, msg, extra = {}) { try { console.log(JSON.stringify({ level, msg, ts: Date.now(), ...extra })); } catch { } }
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

function checkOTE(candles, side) {
  const recent = candles.slice(-50);
  const high = Math.max(...recent.map(c => c.h));
  const low = Math.min(...recent.map(c => c.l));
  const diff = high - low;
  if (diff === 0) return false;
  const price = candles[candles.length - 1].c;
  if (side === "LONG") {
    const oteTop = high - diff * 0.618;
    const oteBottom = high - diff * 0.786;
    return price >= oteBottom && price <= oteTop;
  } else {
    const oteTop = low + diff * 0.786;
    const oteBottom = low + diff * 0.618;
    return price >= oteBottom && price <= oteTop;
  }
}

function checkOrderBlock(candles, side) {
  const recent = candles.slice(-20);
  const price = candles[candles.length - 1].c;
  const tolerance = price * 0.005;
  if (side === "LONG") {
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i].c < recent[i].o && recent[i+1].c > recent[i+1].o) {
        return Math.abs(price - recent[i].c) <= tolerance;
      }
    }
  } else {
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i].c > recent[i].o && recent[i+1].c < recent[i+1].o) {
        return Math.abs(price - recent[i].c) <= tolerance;
      }
    }
  }
  return false;
}

// ✅ BUGFIX #3: قبلاً کندل جاری در محاسبه MA حجم حساب می‌شد (باعث تضعیف سیگنال می‌شد)
function checkToxicFlow(candles) {
  if (!Array.isArray(candles) || candles.length < 21) return false;
  const current = candles[candles.length - 1];
  const prior = candles.slice(-21, -1).map(c => c.v); // exclude current
  if (prior.length < 20) return false;
  const volMA = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(volMA > 0)) return false;
  const body = Math.abs(current.c - current.o);
  const range = current.h - current.l;
  if (range <= 0) return false;
  return (current.v > volMA * 2.5 && body < range * 0.35);
}

function calculateKellyRisk(winRate = 0.55, rr = 2.0) {
  const p = winRate;
  const q = 1 - p;
  const b = rr;
  const f = (b * p - q) / b;
  if (f <= 0) return 0;
  return Math.min(f * 100, RISK_CONFIG.maxKellyRiskPct);
}

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
      results.push({ sweepBar: i, sweepBarTime: k
