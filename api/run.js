// api/run.js
import { runScan, VERSION } from '../lib/bot.js';

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
