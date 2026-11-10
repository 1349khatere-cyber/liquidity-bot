// api/stats.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const rawData = await redis.get("TRADES");
    let trades = { open: [], closed: [] };
    
    if (rawData) {
      trades = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    }

    // ترکیب معاملات باز و بسته
    const allTrades = [
      ...(trades.open || []).map(t => ({ ...t, status: "OPEN" })),
      ...(trades.closed || []).map(t => ({ ...t, status: "CLOSED" }))
    ];

    // مرتب‌سازی بر اساس زمان باز شدن (از جدیدترین به قدیمی‌ترین)
    allTrades.sort((a, b) => (b.sentAt || b.closedAt || 0) - (a.sentAt || a.closedAt || 0));

    // فیلتر ۳ روز اخیر
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const filteredTrades = allTrades.filter(t => (t.sentAt || t.closedAt || 0) > threeDaysAgo);

    // ✅ گرفتن قیمت لحظه‌ای برای معاملات باز
    await Promise.all(filteredTrades.map(async (t) => {
      if (t.status === "OPEN") {
        try {
          const response = await fetch(`https://api.toobit.com/quote/v1/ticker/24hr?symbol=${t.symbol}`);
          const data = await response.json();
          const item = Array.isArray(data) ? data[0] : data;
          const livePrice = Number(item?.lastPrice ?? item?.last ?? item?.price ?? item?.c ?? 0);
          if (livePrice > 0) {
            t.livePrice = livePrice;
            const pnlPct = ((livePrice - t.entry) / t.entry) * 100 * (t.side === "LONG" ? 1 : -1);
            t.livePnlPct = pnlPct;
          }
        } catch (e) {
          // خطا در گرفتن قیمت را نادیده می‌گیریم
        }
      }
    }));

    res.status(200).json({
      ok: true,
      trades: filteredTrades
    });
  } catch (error) {
    console.error("Stats API Error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
}
