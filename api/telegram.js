// api/telegram.js
import { handleTelegramUpdate } from '../lib/bot.js';

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
