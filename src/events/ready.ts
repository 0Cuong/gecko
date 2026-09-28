// ╔══════════════════════════════════════════════════════════════╗
// ║                           IMPORTS                            ║
// ╚══════════════════════════════════════════════════════════════╝

// Discord
import { ActivityType } from "discord.js";

// Types
import type { GeckoClient } from "../client/GeckoClient.js";

// Utils
import { startAutoUpdater } from "../utils/ytdlp/index.js";


// ╔══════════════════════════════════════════════════════════════╗
// ║                         READY EVENT                          ║
// ╚══════════════════════════════════════════════════════════════╝

export default async function ready(client: GeckoClient): Promise<void> {
    // ────────────────────୨ৎ Initialization ୨ৎ────────────────────
    
    // Log successful login
    console.info(`[Gecko] Logged in as ${client.user?.tag}`);

    // ────────────────────୨ৎ Slash Commands ୨ৎ────────────────────
    
    // Register global slash commands
    try {
        await client.registerCommands();
    } catch (error) {
        console.error(
            "[Gecko] Lỗi đăng ký lệnh slash commands:",
            error,
        );
    }

    // ───────────────────୨ৎ Background Tasks ୨ৎ───────────────────
    
    // Initialize auto-updater for yt-dlp binaries
    try {
        startAutoUpdater();
    } catch (error) {
        console.error(
            "[Gecko] Lỗi khi chạy Auto Updater:",
            error,
        );
    }

    // ───────────────────────୨ৎ Presence ୨ৎ───────────────────────
    
    // Configure and update bot presence status
    try {
        client.user?.setActivity(
            "Thích nghe gì thì bật /play <tên bài hát>",
            {
                type: ActivityType.Listening,
            },
        );
    } catch (error) {
        console.error(
            "[Gecko] Không thể cập nhật trạng thái hoạt động của bot:",
            error,
        );
    }
}