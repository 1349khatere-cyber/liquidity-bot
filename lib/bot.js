// @ts-nocheck
// lib/bot.js

import { Redis } from '@upstash/redis';
import { detectSignalEngine2, ENGINE2_VERSION } from './engine2.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VERSION = "1.7.5 (Engine 2 on 5m)"; 
const BASE = "https://api.toobit.com";
const SCHEMA_VERSION = 6;

const SYMBOLS = ["SOL-SWAP-USDT", "XRP-SWAP-USDT", "ADA-SWAP-USDT", "LINK-SWAP-USDT", "AVAX-SWAP-USDT"];
const TIMEFRAMES = ["15m", "1h"];
const TIMEFRAMES_ENGINE2 = ["5m"]; // 🟢 موتور دوم فقط در 5 دقیقه اسکن می‌کند
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

const TREND_CONFIG = { enabled: true, useEma200Filter: true };

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

// بقیه توابع موتور اول (SMC) بدون تغییر ادامه می‌یابند...
// (برای جلوگیری از شلوغی، بخش‌های تکراری را حذف کردم، آن‌ها دقیقاً همان کدهای قبلی هستند)

// 🟢 بخش تغییر یافته: اسکن موتور دوم روی تایم فریم 5m
async function runEngine2Scan(env, now) {
    const signalsSent = [];
    const candidates = [];

    for (const symbol of SYMBOLS) {
        for (const tf of TIMEFRAMES_ENGINE2) { // استفاده از TIMEFRAMES_ENGINE2 (فقط 5m)
            try {
                const candles = await getKlines(symbol, tf, 300);
                const sig2 = detectSignalEngine2(symbol, tf, candles);
                
                if (sig2) {
                    const cooldownKey = `eng2_cd_${symbol}_${tf}`;
                    const lastSent = await kvGet(cooldownKey, 0);
                    if (now - lastSent < 2 * 60 * 60 * 1000) continue; // 2 ساعت کول‌داون
                    candidates.push(sig2);
                }
            } catch (e) { log("warn", "engine2_scan_err", { symbol, tf, err: e.message }); }
        }
    }

    const bestSignals = candidates.slice(0, 2); // حداکثر ۲ سیگنال

    for (const sig2 of bestSignals) {
        let nextId = (await kvGet("signal_counter", 1000)) + 1;
        await kvPut("signal_counter", nextId);
        sig2.signalId = nextId;

        const timeStr = formatTehranTime(now);

        const msg = [
            `⚙️ <b>سیگنال موتور دوم | Engine 2</b>`,
            `────────────────────`,
            `💎 ارز: <b>${sig2.symbol}</b>`,
            `🔢 شماره سیگنال: #${nextId}`,
            `📅 زمان سیگنال: ${timeStr}`,
            `🎯 جهت: <b>${sig2.side === 'LONG' ? '🟢 خرید (LONG)' : '🔴 فروش (SHORT)'}</b>`,
            `────────────────────`,
            `📍 ورود: <code>${fmtPrice(sig2.entry)}</code>`,
            `🛑 حد ضرر: <code>${fmtPrice(sig2.sl)}</code>`,
            `🎯 هدف: <code>${fmtPrice(sig2.tp)}</code>`,
            `────────────────────`,
            `📊 <b>دلیل:</b> ${sig2.reason}`,
            `<i>v${ENGINE2_VERSION}</i>`
        ].join("\n");

        const ok = await sendTelegram(env, msg);
        if (ok) {
            signalsSent.push(sig2);
            await kvPut(`eng2_cd_${sig2.symbol}_${sig2.timeframe}`, now);
            log("info", "engine2_signal_sent", { symbol: sig2.symbol, side: sig2.side, id: nextId });
        }
    }
    return signalsSent;
}

// ... (بقیه فایل دقیقاً مثل نسخه 1.7.4 است و تغییری نکرده) ...
