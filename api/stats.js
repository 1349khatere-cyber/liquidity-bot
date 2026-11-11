// api/stats.js
import { kvGet, computeStats, loadState } from '../lib/bot.js';

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

    return res.status(200).json({
      ok: true,
      stats: stats,
      openTrades: trades.open || [],
      closedTrades: (trades.closed || []).slice(-500).reverse(), // ✅ 500 معامله آخر
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
