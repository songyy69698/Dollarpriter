/**
 * 📱 Telegram 通知模块
 * ═══════════════════════════════════════
 */

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [tg] ${msg}`);
}

export async function notifyTG(text: string): Promise<void> {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" }),
        });
    } catch (e) {
        log(`发送失败: ${e}`);
    }
}

/** 轮询 TG 指令 */
export async function pollTGCommands(
    lastId: number,
    handlers: Record<string, () => Promise<void>>,
): Promise<number> {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        return lastId;
    }
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastId + 1}&timeout=1`,
        );
        const data = (await res.json()) as any;
        if (!data.ok) {
            log(`⚠️ getUpdates 失败: ${JSON.stringify(data)}`);
            return lastId;
        }
        for (const u of data.result || []) {
            lastId = u.update_id;
            const chatId = String(u.message?.chat?.id || "");
            const txt = (u.message?.text || "").trim().toLowerCase();
            
            // DEBUG: 显示收到的每条消息
            log(`📩 收到: "${txt}" from chat=${chatId} (期望=${TG_CHAT_ID})`);
            
            if (chatId !== TG_CHAT_ID) {
                log(`⚠️ chat_id 不匹配! 收到=${chatId} 期望=${TG_CHAT_ID}`);
                continue;
            }
            const handler = handlers[txt];
            if (handler) {
                log(`✅ 执行指令: "${txt}"`);
                await handler();
            } else {
                log(`❓ 未知指令: "${txt}"`);
            }
        }
    } catch (e) {
        log(`❌ TG 轮询异常: ${e}`);
    }
    return lastId;
}
