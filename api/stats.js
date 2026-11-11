// api/stats.js
import { kvGet, computeStats, loadState, getLivePrice } from '../lib/bot.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const trades = await kvGet("TRADES", { open: [], closed: [] });
    const state = await loadState();
    const stats = computeStats(trades.closed || []);

    // ✅ محاسبه سود/ضرر لحظه‌ای برای معاملات باز
    const openTradesWithPnl = await Promise.all((trades.open || []).map(async (t) => {
      try {
        const livePrice = await getLivePrice(t.symbol);
        if (livePrice && t.entry) {
          const pnlPct = ((livePrice - t.entry) / t.entry) * 100 * (t.side === "LONG" ? 1 : -1);
          return { ...t, livePnlPct: pnlPct };
        }
      } catch (e) { /* ignore */ }
      return { ...t, livePnlPct: 0 }; // اگر قیمت خوانده نشد، صفر
    }));

    return res.status(200).json({
      ok: true,
      stats: stats,
      openTrades: openTradesWithPnl,
      closedTrades: (trades.closed || []).slice(-500).reverse(),
      botStatus: {
        paused: state.paused,
        dailyR: state.dailyR,
        dailySignals: state.dailySignalsCount || 0,
        lastRun: state.lastRun
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
