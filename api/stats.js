// api/stats.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  // تنظیم هدر CORS برای دسترسی از مرورگر
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

    // ترکیب معاملات باز و بسته برای نمایش در داشبورد
    const allTrades = [
      ...(trades.open || []).map(t => ({ ...t, status: "OPEN" })),
      ...(trades.closed || [])
    ];

    // مرتب‌سازی بر اساس زمان (جدیدترین‌ها اول)
    allTrades.sort((a, b) => (b.sentAt || b.closedAt || 0) - (a.sentAt || a.closedAt || 0));

    // فیلتر کردن معاملات ۳ روز اخیر (برای اینکه دیتا سبک باشد)
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const filteredTrades = allTrades.filter(t => (t.sentAt || t.closedAt || 0) > threeDaysAgo);

    res.status(200).json({
      ok: true,
      trades: filteredTrades
    });
  } catch (error) {
    console.error("Stats API Error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
}
