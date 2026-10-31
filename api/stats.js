// api/stats.js
import { kvGet, computeStats, loadState } from '../lib/bot.js';

export default async function handler(req, res) {
  // تنظیم هدرها برای اینکه Vercel اجازه دهد سایت شما (v0) به آن وصل شود
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const trades = await kvGet("TRADES", { open: [], closed: [] });
    const state = await loadState();
    const stats = computeStats(trades.closed || []);

    // ارسال تمام داده‌ها به داشبورد
    return res.status(200).json({
      ok: true,
      stats: stats,
      openTrades: trades.open || [],
      closedTrades: (trades.closed || []).slice(-50).reverse(), // 50 معامله آخر
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
