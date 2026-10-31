// api/run.js
import { 
  cfg, getKlines, detectSignal, loadState, saveState, kvGet, kvPut, kvPutThrottled,
  acquireLock, releaseLock, trackOpenTrades, sendTelegram, signalMessage,
  intervalMs, VERSION, SYMBOL_GROUPS, SURVIVAL_CONFIG, SWEEP_CONFIG
} from '../lib/bot.js';

async function runScan(env) {
  const started = Date.now();
  const c = cfg(env);
  const now = Date.now();

  const lock = await acquireLock(now);
  if (!lock.acquired) return { skipped: "locked", tracked: 0 };

  try {
    let state = await loadState();
    let stateChanged = false;

    if (now - state.lastRun < 20000) return { skipped: "scan_delay", tracked: 0 };

    const tzMs = c.tzOffsetMin * 60e3;
    const dayKey = new Date(now + tzMs).toISOString().slice(0, 10);
    if (state.dailyKey !== dayKey) {
      state.dailyKey = dayKey;
      state.dailyR = 0; state.dailySignalsCount = 0; state.dailyLossBlockUntil = 0;
      stateChanged = true;
    }

    const tracking = await trackOpenTrades(env, state.paused);

    for (const t of tracking.closed) {
      const R = Number.isFinite(t.R) ? t.R : null;
      if (R === null) { state.gateStats.void_trades = (state.gateStats.void_trades || 0) + 1; stateChanged = true; continue; }
      state.dailyR = (state.dailyR || 0) + R;
      if (R < 0) {
        state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
        if (state.consecutiveLosses >= SURVIVAL_CONFIG.maxConsecutiveLosses) {
          state.dailyLossBlockUntil = now + SURVIVAL_CONFIG.cooldownAfterConsecutiveMin * 60e3;
          state.consecutiveLosses = 0;
        } else {
          state.dailyLossBlockUntil = now + SURVIVAL_CONFIG.cooldownAfterLossMin * 60e3;
        }
      } else if (R > 0) { state.consecutiveLosses = 0; }

      if (state.dailyR <= -SURVIVAL_CONFIG.maxDailyLossR) {
        const tomorrow = new Date(now + tzMs);
        tomorrow.setUTCHours(0, 0, 0, 0);
        state.dailyLossBlockUntil = tomorrow.getTime() - tzMs + 86400e3;
        await sendTelegram(env, `⚠️ سقف ضرر روزانه (${SURVIVAL_CONFIG.maxDailyLossR}R) — توقف تا فردا`);
      }
      stateChanged = true;
    }
    if (stateChanged) await saveState(state, false);

    if (state.paused) return { skipped: "paused", tracked: tracking.closed.length };
    if (state.dailyLossBlockUntil && now < state.dailyLossBlockUntil) return { skipped: "daily_loss_blocked", tracked: tracking.closed.length };
    if ((state.dailySignalsCount || 0) >= SURVIVAL_CONFIG.maxDailySignals) return { skipped: "daily_signals_limit", tracked: tracking.closed.length };

    const proposals = [];
    for (const symbol of c.symbols) {
      for (const tf of c.timeframes) {
        try {
          const lastSig = await kvGet(`last_${symbol}`, { sentAt: 0 });
          if (now - lastSig.sentAt < SURVIVAL_CONFIG.perSymbolCooldownMin * 60e3) continue;
          
          const candles = await getKlines(symbol, tf, 200);
          const a = await detectSignal(symbol, tf, candles, env);
          if (a) proposals.push(a);
        } catch (e) { console.warn("scan_error", e.message); }
      }
    }

    let sent = 0;
    const openTrades = tracking.trades.open;
    for (const p of proposals) {
      if (sent >= 2) break;
      if (openTrades.length + sent >= 4) break;

      const grp = SYMBOL_GROUPS[p.symbol] || "other";
      const grpCount = openTrades.filter(t => SYMBOL_GROUPS[t.symbol] === grp).length;
      if (grpCount >= SURVIVAL_CONFIG.perGroupMaxOpen) continue;

      const lastLvlKey = `last_lvl_${p.symbol}`;
      const lastLvl = await kvGet(lastLvlKey, { price: 0, sentAt: 0 });
      if (lastLvl.price > 0) {
        const lvlDiffPct = Math.abs(lastLvl.price - p.sweep.swingPrice) / lastLvl.price * 100;
        if (lvlDiffPct < SWEEP_CONFIG.sameLevelCooldownPct) continue;
      }

      let nextId = (await kvGet("signal_counter", 1000)) + 1;

      const sig = {
        id: crypto.randomUUID(), signalId: nextId,
        symbol: p.symbol, timeframe: p.timeframe, side: p.side,
        entry: p.entry, sl: p.sl, tp: p.tp, slDist: p.slDist, rr: p.rr, tpSource: p.tpSource,
        sweep: p.sweep, sweepIsLastBar: p.sweepIsLastBar,
        rsi: p.rsi, adx: p.adx, volRatio: p.volRatio, volRank: p.volRank,
        pattern: p.pattern, trends: p.trends, atr: p.atr,
        confluence: p.confluence, sentAt: now, lastT: p.lastCandleT,
        lastClose: p.entry, candleTime: p.candleTime
      };

      const ok = await sendTelegram(env, signalMessage(sig, c, nextId));
      if (ok) {
        sent++;
        await kvPut("signal_counter", nextId);
        openTrades.push(sig);
        state.dailySignalsCount = (state.dailySignalsCount || 0) + 1;
        state.lastSignals[p.symbol] = now;
        state.lastSignalAt = now;
        state.lastSignalCount = (state.lastSignalCount || 0) + 1;
        await kvPut(`last_${p.symbol}`, { sentAt: now });
        await kvPut(lastLvlKey, { price: p.sweep.swingPrice, sentAt: now });
        await saveState(state, true);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const trades = tracking.trades;
    trades.open = openTrades;
    if (!Array.isArray(trades.closed)) trades.closed = [];
    await kvPutThrottled("TRADES", trades, false);

    state.lastRun = now;
    await saveState(state, false);

    return { sent, proposals: proposals.length, tracked: tracking.closed.length, elapsedMs: Date.now() - started };
  } finally {
    await releaseLock(lock.token);
  }
}

export default async function handler(req, res) {
  const apiKey = req.headers['x-api-key'];
  if (process.env.API_SECRET && apiKey !== process.env.API_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const result = await runScan(process.env);
    return res.status(200).json({ ok: true, version: VERSION, result });
  } catch (error) {
    console.error("Run error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
