// api/telegram.js
import { 
  cfg, sendTelegram, esc, fmtPrice, VERSION, loadState, saveState, 
  kvGet, kvPut, computeStats, getKlines, detectSignal, intervalMs,
  fmt, formatTehranTime, MIN_CONFLUENCE_SCORE, SURVIVAL_CONFIG,
  CONFIRMATION_CONFIG, TREND_CONFIG, MSS_CONFIG, SWEEP_CONFIG, RISK_CONFIG,
  whySignal, formatWhyReport, SWEEP_ALERT_CONFIG
} from '../lib/bot.js';

async function getStatsText(env) {
  const trades = await kvGet("TRADES", { open: [], closed: [] });
  const s = computeStats(trades.closed || []);
  const state = await loadState();
  const pf = Number.isFinite(s.profitFactor) ? fmt(s.profitFactor, 2) : "∞";
  const ci = Number.isFinite(s.ci95) ? ` ±${fmt(s.ci95, 2)}` : "";
  const lines = [
    `📈 <b>آمار LIQUIDITY HUNTER v${VERSION}</b>`, "━━━━━━━━━━━━━━",
    `بسته: <b>${s.n}</b> | باز: ${(trades.open || []).length}`,
    `✅ TP: ${s.wins} | 🛑 SL: ${s.losses} | ⏱ EXP: ${s.expired}`,
    `🎯 Win rate: <b>${fmt(s.winRate * 100, 1)}%</b>`,
    `💹 Expectancy: <b>${fmt(s.expectancy, 3)}R</b>${ci}`,
    `Σ R: ${fmt(s.totalR, 2)} | Avg R: ${fmt(s.avgR, 3)}R | PF: ${pf}`,
    `📉 Max DD: ${fmt(s.maxDD, 2)}R`,
    `🏆 بهترین: ${fmt(s.bestR, 2)}R | 💀 بدترین: ${fmt(s.worstR, 2)}R`, "",
    `📅 روز: ${state.dailyKey || "-"}`,
    `   R: ${fmt(state.dailyR, 2)} | سیگنال: ${state.dailySignalsCount || 0}/${SURVIVAL_CONFIG.maxDailySignals}`,
    `   ضرر متوالی: ${state.consecutiveLosses || 0}`,
    s.n < 20 ? "⚠️ نمونه کمتر از ۲۰" : "✅ نمونه کافی"
  ];
  return lines.join("\n");
}

async function handleTelegramUpdate(env, update) {
  const msg = update?.message;
  if (!msg || !msg.text) return;
  if (env.TELEGRAM_CHAT_ID && String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;

  const text = msg.text.trim();
  const [cmd, ...args] = text.split(/\s+/);
  const c = cfg(env);

  if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(env, [
      `⚡ <b>Liquidity Hunter v${VERSION}</b>`,
      `<i>استراتژی: شکار استاپ (Liquidity Sweep) + تغییر ساختار (MSS)</i>`, ``,
      `نمادها: ${c.symbols.join(", ")}`, `تایم‌فریم‌ها: ${c.timeframes.join(", ")}`, ``,
      `دستورات:`,
      `/status /health /stats /positions /check /why /diag /pause /resume`
    ].join("\n"));
    return;
  }

  if (cmd === "/why" || cmd === "/test") {
    const sym = args[0] || c.symbols[0];
    const tf = args[1] || "15m";
    await sendTelegram(env, `⏳ در حال تحلیل کامل ${esc(sym)} ${esc(tf)}...`);
    try { 
      const r = await whySignal(env, sym, tf); 
      await sendTelegram(env, formatWhyReport(r)); 
    }
    catch (e) { await sendTelegram(env, `❌ خطا: ${esc(e.message)}`); }
    return;
  }

  if (cmd === "/diag") {
    const state = await loadState();
    const trades = await kvGet("TRADES", { open: [], closed: [] });
    const pendingRetry = (trades.open || []).filter(t => t.pendingClose).length;
    const lines = [
      `<b>Diag v${VERSION}</b>`, `Paused: ${state.paused}`, `Schema: ${state.schema}`,
      `Daily R: ${fmt(state.dailyR, 2)}`, `Daily signals: ${state.dailySignalsCount || 0}/${SURVIVAL_CONFIG.maxDailySignals}`,
      `Consecutive losses: ${state.consecutiveLosses || 0}`,
      `Daily blocked until: ${state.dailyLossBlockUntil ? formatTehranTime(state.dailyLossBlockUntil) : "-"}`,
      `Pending close retry: ${pendingRetry}`,
      `minSweepDepthPct: ${SWEEP_CONFIG.minSweepDepthPct}%`, `requireAdxMin: ${CONFIRMATION_CONFIG.requireAdxMin}`,
      `Hard Trend Filter: ${TREND_CONFIG.enabled ? "✅" : "❌"}`, `MSS Confirmation: ${MSS_CONFIG.enabled ? "✅" : "❌"}`,
      `Setup-Level Cooldown: ✅ (${SWEEP_CONFIG.sameLevelCooldownPct}%)`,
      `Sweep Alert: ${SWEEP_ALERT_CONFIG.enabled ? "✅" : "❌ (غیرفعال)"}`,
      `Max Entry Drift: ${c.maxEntryDriftPct}%`, `TG Secret: ${env.TELEGRAM_SECRET ? "✅ فعال" : "⚠️ تنظیم نشده"}`
    ];
    const gs = Object.entries(state.gateStats || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (gs.length) { lines.push("", "🔒 گیت‌های پرتکرار:"); for (const [k, v] of gs) lines.push(`   ${esc(k)}: ${v}`); }
    await sendTelegram(env, lines.join("\n"));
    return;
  }

  if (cmd === "/health") {
    await sendTelegram(env, [
      `<b>Health v${VERSION}</b>`, `استراتژی: Liquidity Sweep`, `Min Score: ${MIN_CONFLUENCE_SCORE}/10`,
      `minSweepDepth: ${SWEEP_CONFIG.minSweepDepthPct}%`, `min ADX: ${CONFIRMATION_CONFIG.requireAdxMin}`,
      `Hard Trend Filter: ✅`, `MSS Confirmation: ✅`, `Sweep Alert: ❌`,
      `Symbols: ${c.symbols.length}`, `Timeframes: ${c.timeframes.join(", ")}`,
      `Max Entry Drift: ${c.maxEntryDriftPct}%`, `Min SL: ${RISK_CONFIG.minSlPct}% / ${RISK_CONFIG.minSlAtr} ATR`,
      `TG Secret: ${env.TELEGRAM_SECRET ? "✅" : "⚠️ تنظیم نشده"}`
    ].join("\n"));
    return;
  }

  if (cmd === "/status") {
    const state = await loadState();
    const trades = await kvGet("TRADES", { open: [], closed: [] });
    const open = trades.open || [];
    const closed = trades.closed || [];
    const pendingRetry = open.filter(t => t.pendingClose).length;
    const lastRunStr = state.lastRun ? formatTehranTime(state.lastRun) : "—";

    await sendTelegram(env, [
      `<b>وضعیت V${VERSION}</b>`,
      `معاملات باز: ${open.length} (در انتظار ارسال: ${pendingRetry})`,
      `معاملات بسته: ${closed.length}`,
      `آخرین بررسی: ${lastRunStr}`,
      `────────────────────`,
      `🎯 Timeframe: ${c.timeframes.join(", ")} | Symbols: ${c.symbols.length}`,
      `Daily Limit: ${SURVIVAL_CONFIG.maxDailySignals} per day`,
      `Min Confluence: ${MIN_CONFLUENCE_SCORE}/10`,
      `Daily Loss Block: ${state.dailyLossBlockUntil && state.dailyLossBlockUntil > Date.now() ? "فعال ⛔" : "غیرفعال ✅"}`,
      `Paused: ${state.paused ? "بله ⏸" : "خیر ▶️"}`
    ].join("\n"));
    return;
  }

  if (cmd === "/stats") { await sendTelegram(env, await getStatsText(env)); return; }

  if (cmd === "/positions") {
    const trades = await kvGet("TRADES", { open: [] });
    const open = trades.open || [];
    if (!open.length) { await sendTelegram(env, "هیچ سیگنال بازی نیست."); return; }
    const lines = [`<b>سیگنال‌های باز: ${open.length}</b>`];
    for (const s of open) { 
      lines.push(`• ${esc(s.symbol)} ${esc(s.side)} @ <code>${fmtPrice(s.entry)}</code>`); 
      lines.push(`   SL <code>${fmtPrice(s.sl)}</code> | TP <code>${fmtPrice(s.tp)}</code>`); 
    }
    await sendTelegram(env, lines.join("\n"));
    return;
  }

  if (cmd === "/check") {
    await sendTelegram(env, "⏳ در حال بررسی... (لطفا صبر کنید)");
    try {
      const url = 'https://liquidity-bot-khaki.vercel.app/api/run';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': process.env.API_SECRET || '' }
      });
      const data = await res.json();
      
      if (data.ok) {
        const r = data.result;
        let replyMsg = "";
        if (r.skipped) {
          replyMsg = `⏸ بررسی رد شد: ${r.skipped}`;
        } else {
          replyMsg = `✅ بررسی تمام شد\n🎯 سیگنال‌ها: ${r.sent}\n📋 پیشنهاد: ${r.proposals}\n✅ بسته‌شده: ${r.tracked}\n⏱ زمان: ${r.elapsedMs}ms`;
        }
        await sendTelegram(env, replyMsg);
      } else {
        await sendTelegram(env, `❌ خطا در بررسی: ${esc(data.error)}`);
      }
    } catch (e) {
      await sendTelegram(env, `❌ خطا در ارتباط با سرور: ${esc(e.message)}`);
    }
    return;
  }

  if (cmd === "/pause") {
    const state = await loadState();
    state.paused = true; state.pausedReason = `manual@${new Date().toISOString()}`;
    await saveState(state, true);
    await sendTelegram(env, "⏸ ربات متوقف شد.");
    return;
  }

  if (cmd === "/resume") {
    const state = await loadState();
    state.paused = false; state.pausedReason = ""; state.dailyLossBlockUntil = 0;
    await saveState(state, true);
    await sendTelegram(env, "▶️ ربات فعال شد.");
    return;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (process.env.TELEGRAM_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== process.env.TELEGRAM_SECRET) return res.status(401).send("unauthorized");
  }
  try {
    await handleTelegramUpdate(process.env, req.body);
    return res.status(200).send("ok");
  } catch (e) {
    console.error("TG Webhook error:", e);
    return res.status(200).send("ok");
  }
}
