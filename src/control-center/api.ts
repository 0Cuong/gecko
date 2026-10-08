/**
 * Gecko Discord Bot Control Center - REST API Router
 * Secure backend API for the browser control center.
 */

import type http from "node:http";
import { ChannelType, PermissionsBitField } from "discord.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { addControlLog, getControlLogs, registerSseClient } from "./logger.js";
import { consumeControlRateLimit, verifyAdminAuth, logAuthFailure } from "./auth.js";

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    const jsonStr = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Control-Key"
    });
    res.end(jsonStr);
}

function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 512 * 1024) {
                // Protect against oversized body
                req.destroy();
                reject(new Error("Request body too large"));
            }
        });
        req.on("end", () => {
            if (!body.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}

export async function handleControlCenterApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: GeckoClient
): Promise<boolean> {
    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
    const path = parsedUrl.pathname;

    // /api/health is intentionally public. All other API routes require the
    // production auth boundary before any route-specific logic is evaluated.
    if (path !== "/api/health" && path.startsWith("/api/")) {
        if (!consumeControlRateLimit(req)) {
            sendJson(res, 429, {
                success: false,
                error: { code: "RATE_LIMITED", message: "Too many requests." }
            });
            return true;
        }
        if (!verifyAdminAuth(req)) {
            logAuthFailure(req, path);
            sendJson(res, 401, {
                success: false,
                error: { code: "UNAUTHORIZED", message: "Yêu cầu quyền quản trị viên hợp lệ." }
            });
            return true;
        }
    }

    // Handle CORS preflight
    if (req.method === "OPTIONS" && path.startsWith("/api/")) {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Control-Key",
            "Access-Control-Max-Age": "86400"
        });
        res.end();
        return true;
    }

    if (!path.startsWith("/api/")) {
        return false;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 1. GET /api/health
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/health" && req.method === "GET") {
        const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        sendJson(res, 200, {
            success: true,
            data: {
                status: client.isReady() ? "online" : (client.config.token ? "connecting" : "awaiting_token"),
                uptimeSeconds: Math.floor(process.uptime()),
                memoryMB: heapMB,
                rssMB: rssMB,
                version: "1.0.0",
                timestamp: new Date().toISOString()
            }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 2. GET /api/status
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/status" && req.method === "GET") {
        const isOnline = client.isReady();
        const wsStatus = client.ws ? client.ws.status : -1;
        const wsStatusString = isOnline ? "connected" : (wsStatus === 0 ? "connecting" : "disconnected");

        let totalMembers = 0;
        let activeVoiceCount = 0;

        if (isOnline) {
            for (const guild of client.guilds.cache.values()) {
                totalMembers += guild.memberCount || 0;
            }
            for (const q of client.queues.values()) {
                if (q.connection?.joinConfig.channelId) activeVoiceCount++;
            }
        }

        sendJson(res, 200, {
            success: true,
            data: {
                bot: {
                    id: client.user?.id || null,
                    username: client.user?.username || "Gecko",
                    tag: client.user?.tag || "Gecko#0000",
                    avatar: client.user?.displayAvatarURL({ extension: "png" }) || null,
                    isReady: isOnline,
                    hasTokenConfigured: Boolean(client.config.token)
                },
                connection: {
                    status: isOnline ? "ONLINE" : (client.config.token ? "CONNECTING" : "AWAITING_TOKEN"),
                    wsStatus: wsStatusString,
                    pingMs: isOnline && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
                    uptimeSeconds: Math.floor(process.uptime()),
                    lastHeartbeat: client.ws ? new Date().toISOString() : null
                },
                metrics: {
                    guildsCount: isOnline ? client.guilds.cache.size : 0,
                    totalUsersCount: totalMembers,
                    activeQueuesCount: client.queues.size,
                    activeVoiceCount: activeVoiceCount,
                    commandsCount: client.commands.size,
                    memoryHeapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    memoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
                }
            }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 3. GET /api/bot
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/bot" && req.method === "GET") {
        sendJson(res, 200, {
            success: true,
            data: {
                id: client.user?.id || null,
                tag: client.user?.tag || null,
                username: client.user?.username || "Gecko",
                avatar: client.user?.displayAvatarURL() || null,
                isReady: client.isReady(),
                tokenConfigured: Boolean(client.config.token),
                devGuildId: client.config.devGuildId || null,
                defaultVolume: client.config.defaultVolume,
                commandsLoaded: client.commands.size,
                guildsConnected: client.guilds.cache.size
            }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 4. POST /api/bot/connect
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/bot/connect" && req.method === "POST") {
        if (!verifyAdminAuth(req)) {
            logAuthFailure(req, "bot_connect");
            sendJson(res, 401, {
                success: false,
                error: { code: "UNAUTHORIZED", message: "Yêu cầu quyền quản trị viên hợp lệ." }
            });
            return true;
        }

        if (client.isReady()) {
            sendJson(res, 200, {
                success: true,
                message: "Bot đã trực tuyến và kết nối sẵn sàng.",
                data: { isReady: true, tag: client.user?.tag }
            });
            return true;
        }

        if (!client.config.token) {
            sendJson(res, 400, {
                success: false,
                error: { code: "NO_TOKEN", message: "Chưa cấu hình BOT_TOKEN trên server. Vui lòng thiết lập biến môi trường BOT_TOKEN." }
            });
            return true;
        }

        try {
            addControlLog("info", "BOT_CONNECT_INIT", "Khởi tạo kết nối bot Discord từ Control Center...");
            await client.login(client.config.token);
            addControlLog("success", "BOT_CONNECT_SUCCESS", `Bot đăng nhập thành công với danh tính ${client.user?.tag}`);
            sendJson(res, 200, {
                success: true,
                message: "Kết nối thành công!",
                data: { isReady: true, tag: client.user?.tag }
            });
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            addControlLog("error", "BOT_CONNECT_FAILED", "Discord login failed.", { errorType: errorMsg.slice(0, 120) });
            sendJson(res, 500, {
                success: false,
                error: { code: "LOGIN_FAILED", message: "Internal server error." }
            });
        }
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 5. POST /api/bot/disconnect
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/bot/disconnect" && req.method === "POST") {
        if (!verifyAdminAuth(req)) {
            logAuthFailure(req, "bot_disconnect");
            sendJson(res, 401, {
                success: false,
                error: { code: "UNAUTHORIZED", message: "Yêu cầu quyền quản trị viên hợp lệ." }
            });
            return true;
        }

        try {
            const tag = client.user?.tag || "Bot";
            // Clean active voice connections and queues
            for (const [guildId, queue] of client.queues) {
                try {
                    queue.destroy();
                } catch {
                    // Ignore individual queue cleanup error
                }
                client.queues.delete(guildId);
            }
            client.destroy();
            addControlLog("warn", "BOT_DISCONNECTED", `Bot ${tag} đã ngắt kết nối theo lệnh từ Control Center.`);
            sendJson(res, 200, {
                success: true,
                message: "Đã ngắt kết nối bot an toàn."
            });
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            sendJson(res, 500, {
                success: false,
                error: { code: "DISCONNECT_ERROR", message: "Internal server error." }
            });
        }
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 6. POST /api/bot/restart
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/bot/restart" && req.method === "POST") {
        if (!verifyAdminAuth(req)) {
            logAuthFailure(req, "bot_restart");
            sendJson(res, 401, {
                success: false,
                error: { code: "UNAUTHORIZED", message: "Yêu cầu quyền quản trị viên hợp lệ." }
            });
            return true;
        }

        try {
            addControlLog("info", "BOT_RESTARTING", "Đang tái khởi động client bot Discord...");
            client.destroy();
            if (client.config.token) {
                await client.login(client.config.token);
                addControlLog("success", "BOT_RESTARTED", `Bot đã tái khởi động thành công as ${client.user?.tag}`);
                sendJson(res, 200, {
                    success: true,
                    message: "Tái khởi động bot thành công!",
                    data: { tag: client.user?.tag }
                });
            } else {
                addControlLog("warn", "BOT_RESTART_DEFERRED", "Client đã reset nhưng thiếu BOT_TOKEN.");
                sendJson(res, 200, {
                    success: true,
                    message: "Client đã reset, đang chờ cấu hình BOT_TOKEN."
                });
            }
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            addControlLog("error", "BOT_RESTART_ERROR", `Lỗi khi tái khởi động bot: ${errorMsg}`);
            sendJson(res, 500, {
                success: false,
                error: { code: "RESTART_FAILED", message: "Internal server error." }
            });
        }
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 7. GET /api/guilds
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/guilds" && req.method === "GET") {
        if (!client.isReady()) {
            sendJson(res, 200, {
                success: true,
                data: [],
                meta: { botStatus: "OFFLINE", message: "Bot đang ngoại tuyến hoặc chưa kết nối Discord." }
            });
            return true;
        }

        const guildsList = [...client.guilds.cache.values()].map((guild) => {
            const textCount = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).size;
            const voiceCount = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).size;
            return {
                id: guild.id,
                name: guild.name,
                icon: guild.iconURL({ extension: "png", size: 128 }) || null,
                memberCount: guild.memberCount,
                ownerId: guild.ownerId,
                joinedAt: guild.joinedAt?.toISOString() || null,
                channelsCount: {
                    text: textCount,
                    voice: voiceCount,
                    total: guild.channels.cache.size
                },
                botPermissions: {
                    administrator: guild.members.me?.permissions.has(PermissionsBitField.Flags.Administrator) || false,
                    manageChannels: guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageChannels) || false,
                    sendMessages: guild.members.me?.permissions.has(PermissionsBitField.Flags.SendMessages) || false,
                    connectVoice: guild.members.me?.permissions.has(PermissionsBitField.Flags.Connect) || false
                }
            };
        });

        sendJson(res, 200, {
            success: true,
            data: guildsList,
            meta: { total: guildsList.length }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 8. GET /api/guilds/:guildId/channels
    // ──────────────────────────────────────────────────────────────────────────
    const guildChannelsMatch = path.match(/^\/api\/guilds\/([0-9]+)\/channels$/);
    if (guildChannelsMatch && req.method === "GET") {
        if (!client.isReady()) {
            sendJson(res, 503, {
                success: false,
                error: { code: "BOT_OFFLINE", message: "Bot chưa kết nối Discord." }
            });
            return true;
        }

        const guildId = guildChannelsMatch[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            sendJson(res, 404, {
                success: false,
                error: { code: "GUILD_NOT_FOUND", message: `Không tìm thấy máy chủ với ID ${guildId}` }
            });
            return true;
        }

        const channelsList = [...guild.channels.cache.values()]
            .map((ch) => {
                let typeName = "OTHER";
                if (ch.type === ChannelType.GuildText) typeName = "TEXT";
                else if (ch.type === ChannelType.GuildVoice) typeName = "VOICE";
                else if (ch.type === ChannelType.GuildAnnouncement) typeName = "ANNOUNCEMENT";
                else if (ch.type === ChannelType.GuildCategory) typeName = "CATEGORY";
                else if (ch.type === ChannelType.GuildForum) typeName = "FORUM";
                else if (ch.type === ChannelType.GuildStageVoice) typeName = "STAGE";

                const me = guild.members.me;
                const canSend = me ? me.permissionsIn(ch).has(PermissionsBitField.Flags.SendMessages) : false;
                const canView = me ? me.permissionsIn(ch).has(PermissionsBitField.Flags.ViewChannel) : false;
                const position = "position" in ch && typeof (ch as any).position === "number" ? (ch as any).position : 0;

                return {
                    id: ch.id,
                    name: ch.name,
                    type: typeName,
                    rawType: ch.type,
                    parentId: ch.parentId || null,
                    position,
                    canView,
                    canSend
                };
            })
            .sort((a, b) => a.position - b.position);

        sendJson(res, 200, {
            success: true,
            data: {
                guild: { id: guild.id, name: guild.name },
                channels: channelsList
            }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 9. POST /api/guilds/:guildId/channels/:channelId/messages
    // ──────────────────────────────────────────────────────────────────────────
    const postMessageMatch = path.match(/^\/api\/guilds\/([0-9]+)\/channels\/([0-9]+)\/messages$/);
    if (postMessageMatch && req.method === "POST") {
        if (!verifyAdminAuth(req)) {
            logAuthFailure(req, "send_message");
            sendJson(res, 401, {
                success: false,
                error: { code: "UNAUTHORIZED", message: "Yêu cầu quyền quản trị viên hợp lệ để gửi tin nhắn." }
            });
            return true;
        }

        if (!client.isReady()) {
            sendJson(res, 503, {
                success: false,
                error: { code: "BOT_OFFLINE", message: "Bot chưa kết nối Discord." }
            });
            return true;
        }

        const [, guildId, channelId] = postMessageMatch;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            sendJson(res, 404, {
                success: false,
                error: { code: "GUILD_NOT_FOUND", message: "Máy chủ Discord không tồn tại hoặc bot chưa tham gia." }
            });
            return true;
        }

        let body: Record<string, unknown> = {};
        try {
            body = await parseJsonBody(req);
        } catch {
            sendJson(res, 400, {
                success: false,
                error: { code: "INVALID_BODY", message: "Dữ liệu JSON không hợp lệ." }
            });
            return true;
        }

        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
            sendJson(res, 400, {
                success: false,
                error: { code: "EMPTY_CONTENT", message: "Nội dung tin nhắn không được để trống." }
            });
            return true;
        }

        if (content.length > 2000) {
            sendJson(res, 400, {
                success: false,
                error: { code: "CONTENT_TOO_LONG", message: "Tin nhắn vượt quá giới hạn 2000 ký tự của Discord." }
            });
            return true;
        }

        try {
            const channel = await guild.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("send" in channel)) {
                sendJson(res, 400, {
                    success: false,
                    error: { code: "NOT_TEXT_CHANNEL", message: "Kênh đã chọn không hỗ trợ gửi tin nhắn văn bản." }
                });
                return true;
            }

            const me = guild.members.me;
            if (me && !me.permissionsIn(channel).has(PermissionsBitField.Flags.SendMessages)) {
                sendJson(res, 403, {
                    success: false,
                    error: { code: "PERMISSION_DENIED", message: "Bot không có quyền SendMessages trong kênh này." }
                });
                return true;
            }

            const sent = await (channel as any).send({ content });
            addControlLog("success", "MESSAGE_SENT", `Đã gửi tin nhắn đến #${channel.name} (${guild.name})`, {
                channelId,
                messageId: sent.id
            });

            sendJson(res, 200, {
                success: true,
                data: {
                    id: sent.id,
                    channelId: sent.channelId,
                    guildId: sent.guildId,
                    content: sent.content,
                    createdAt: sent.createdAt.toISOString()
                }
            });
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            addControlLog("error", "MESSAGE_SEND_ERROR", `Lỗi gửi tin nhắn: ${errorMsg}`);
            sendJson(res, 500, {
                success: false,
                error: { code: "DISCORD_API_ERROR", message: "Internal server error." }
            });
        }
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 10. GET /api/commands
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/commands" && req.method === "GET") {
        const commandsList = [...client.commands.values()].map((cmd) => {
            const name = cmd.data.name;
            let category = "Playback";
            if (["queue", "nowplaying", "search", "remove", "clear", "move"].includes(name)) {
                category = "Queue";
            } else if (["loop", "shuffle", "autoplay"].includes(name)) {
                category = "Modes";
            } else if (["join", "leave", "system", "help"].includes(name)) {
                category = "System";
            }

            return {
                name: cmd.data.name,
                description: cmd.data.description || "",
                category,
                enabled: true,
                defaultMemberPermissions: cmd.data.default_member_permissions || null
            };
        });

        sendJson(res, 200, {
            success: true,
            data: commandsList,
            meta: { total: commandsList.length }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 11. GET /api/logs & GET /api/logs/stream
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/logs/stream" && req.method === "GET") {
        registerSseClient(res);
        return true;
    }

    if (path === "/api/logs" && req.method === "GET") {
        const logs = getControlLogs(100);
        sendJson(res, 200, {
            success: true,
            data: logs,
            meta: { count: logs.length }
        });
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 12. POST /api/console/execute (Predefined Safe Admin Actions)
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/console/execute" && req.method === "POST") {
        if (!verifyAdminAuth(req)) {
            logAuthFailure(req, "console_execute");
            sendJson(res, 401, {
                success: false,
                error: { code: "UNAUTHORIZED", message: "Yêu cầu quyền quản trị viên hợp lệ." }
            });
            return true;
        }

        let body: Record<string, unknown> = {};
        try {
            body = await parseJsonBody(req);
        } catch {
            sendJson(res, 400, {
                success: false,
                error: { code: "INVALID_BODY", message: "JSON không hợp lệ." }
            });
            return true;
        }

        const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
        addControlLog("info", "CONSOLE_EXECUTE", `Thực thi lệnh console an toàn: [${action}]`);

        switch (action) {
            case "ping": {
                const gatewayPing = client.ws ? Math.round(client.ws.ping) : -1;
                sendJson(res, 200, {
                    success: true,
                    data: {
                        action: "ping",
                        gatewayPingMs: gatewayPing,
                        httpRoundtripMs: 1,
                        status: client.isReady() ? "CONNECTED" : "OFFLINE"
                    }
                });
                return true;
            }

            case "status": {
                sendJson(res, 200, {
                    success: true,
                    data: {
                        action: "status",
                        bot: client.user ? { tag: client.user.tag, id: client.user.id } : "Not Logged In",
                        guildsCount: client.guilds.cache.size,
                        queuesCount: client.queues.size,
                        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                        uptime: `${Math.floor(process.uptime())}s`,
                        nodeVersion: process.version
                    }
                });
                return true;
            }

            case "reconnect": {
                if (client.isReady() && client.config.token) {
                    addControlLog("warn", "GATEWAY_RECONNECT", "Thực thi kết nối lại Gateway Discord...");
                    client.destroy();
                    await client.login(client.config.token);
                }
                sendJson(res, 200, {
                    success: true,
                    message: "Đã yêu cầu WebSocket Gateway tái kết nối."
                });
                return true;
            }

            case "sync_commands": {
                if (!client.isReady()) {
                    sendJson(res, 400, {
                        success: false,
                        error: { code: "BOT_OFFLINE", message: "Bot phải online để đăng ký slash commands." }
                    });
                    return true;
                }
                try {
                    await client.registerCommands();
                    addControlLog("success", "COMMANDS_SYNCED", `Đã đồng bộ ${client.commands.size} lệnh slash lên Discord.`);
                    sendJson(res, 200, {
                        success: true,
                        message: `Đã đồng bộ thành công ${client.commands.size} lệnh slash!`
                    });
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    sendJson(res, 500, {
                        success: false,
                        error: { code: "SYNC_FAILED", message: "Internal server error." }
                    });
                }
                return true;
            }

            case "clean_queues": {
                let cleaned = 0;
                for (const [guildId, queue] of client.queues) {
                    if (queue.songs.length === 0 && !queue.currentSong) {
                        try {
                            queue.destroy();
                        } catch {
                            // Ignored
                        }
                        client.queues.delete(guildId);
                        cleaned++;
                    }
                }
                addControlLog("info", "QUEUES_CLEANED", `Đã dọn dẹp ${cleaned} hàng đợi nhạc không hoạt động.`);
                sendJson(res, 200, {
                    success: true,
                    message: `Đã dọn dẹp ${cleaned} hàng đợi nhàn rỗi.`,
                    data: { cleanedCount: cleaned, remainingCount: client.queues.size }
                });
                return true;
            }

            case "guilds": {
                const list = [...client.guilds.cache.values()].map((g) => ({
                    id: g.id,
                    name: g.name,
                    members: g.memberCount
                }));
                sendJson(res, 200, {
                    success: true,
                    data: { action: "guilds", guilds: list, total: list.length }
                });
                return true;
            }

            default: {
                sendJson(res, 400, {
                    success: false,
                    error: {
                        code: "UNKNOWN_ACTION",
                        message: `Lệnh console không xác định: "${action}". Các lệnh khả dụng: ping, status, reconnect, sync_commands, clean_queues, guilds`
                    }
                });
                return true;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 13. GET & POST /api/config
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/api/config" && req.method === "GET") {
        sendJson(res, 200, {
            success: true,
            data: {
                tokenConfigured: Boolean(client.config.token),
                devGuildId: client.config.devGuildId || "",
                defaultVolume: client.config.defaultVolume,
                idleTimeout: client.config.idleTimeout / 1000,
                emptyVoiceTimeout: client.config.emptyVoiceTimeout / 1000,
                maxQueueSize: client.config.maxQueueSize,
                authRequired: Boolean(process.env.CONTROL_CENTER_KEY)
            }
        });
        return true;
    }

    sendJson(res, 404, {
        success: false,
        error: { code: "NOT_FOUND", message: `Đường dẫn API không tồn tại: ${path}` }
    });
    return true;
}
