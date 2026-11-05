async function runEngine2Scan(env, now) {
    const signalsSent = [];
    const candidates = [];

    // 1. جمع‌آوری تمام سیگنال‌های ممکن
    for (const symbol of SYMBOLS) {
        for (const tf of TIMEFRAMES) {
            try {
                const candles = await getKlines(symbol, tf, 300);
                const sig2 = detectSignalEngine2(symbol, tf, candles);
                
                if (sig2) {
                    const cooldownKey = `eng2_cd_${symbol}_${tf}`;
                    const lastSent = await kvGet(cooldownKey, 0);
                    if (now - lastSent < 2 * 60 * 60 * 1000) continue; // 2 ساعت کول‌داون

                    candidates.push(sig2);
                }
            } catch (e) {
                log("warn", "engine2_scan_err", { symbol, tf, err: e.message });
            }
        }
    }

    // 2. مرتب‌سازی سیگنال‌ها (می‌توانید بر اساس قدرت روند مرتب کنید، فعلاً به همان ترتیب)
    // 3. فقط ۲ سیگنال برتر را انتخاب کنید تا تلگرام اسپم نشود
    const bestSignals = candidates.slice(0, 2);

    for (const sig2 of bestSignals) {
        const msg = [
            `⚙️ <b>سیگنال موتور دوم (Engine 2)</b>`,
            `<i>استراتژی: روند و مومنتوم (۱۰ روزه)</i>`,
            `────────────────────`,
            `💎 <b>${sig2.symbol}</b> | تایم‌فریم: ${sig2.timeframe}`,
            `🎯 جهت: <b>${sig2.side === 'LONG' ? '🟢 خرید' : '🔴 فروش'}</b>`,
            `────────────────────`,
            // 🟢 استفاده از fmtPrice به جای fmt برای نمایش دقیق اعشار
            `📍 ورود: <code>${fmtPrice(sig2.entry)}</code>`,
            `🛑 حد ضرر: <code>${fmtPrice(sig2.sl)}</code>`,
            `🎯 هدف: <code>${fmtPrice(sig2.tp)}</code>`,
            `────────────────────`,
            `📊 <b>دلیل:</b> ${sig2.reason}`,
            `────────────────────`,
            `⏰ ${formatTehranTime(now)}`,
            `<i>v${ENGINE2_VERSION}</i>`
        ].join("\n");

        const ok = await sendTelegram(env, msg);
        if (ok) {
            signalsSent.push(sig2);
            const cooldownKey = `eng2_cd_${sig2.symbol}_${sig2.timeframe}`;
            await kvPut(cooldownKey, now);
            log("info", "engine2_signal_sent", { symbol: sig2.symbol, side: sig2.side });
        }
    }
    return signalsSent;
}
