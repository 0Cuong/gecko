import "./polyfill.js";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodePath from "node:path";
import http from "node:http";
import { Events, Status } from "discord.js";

import { config } from "./config/index.js";
import { GeckoClient } from "./client/GeckoClient.js";
import { verifyAndEnsureBinary, stopAutoUpdater } from "./utils/ytdlp/index.js";
import type { SlashCommand } from "./client/types.js";
import { metrics } from "./utils/metrics.js";

import readyHandler from "./events/ready.js";
import interactionHandler from "./events/interactionCreate.js";
import voiceStateUpdateHandler from "./events/voiceStateUpdate.js";
import { handleControlCenterApi } from "./control-center/api.js";
import { addControlLog } from "./control-center/logger.js";

export interface ProjectIdentity {
    readonly brand: string;
    readonly project: string;
    readonly author: string;
    readonly repository: string;
    readonly copyright: string;
    readonly projectId: string;
    readonly status: "DEVELOPMENT" | "STAGING" | "PRODUCTION";
    readonly version: string;
    readonly publicKey?: string;
}

export const IDENTITY: ProjectIdentity = {
    brand: "0CUONG",
    project: "Gecko Music Bot",
    author: "0CUONG",
    repository: "https://github.com/0Cuong",
    copyright: "© 2026 0CUONG. All rights reserved.",
    projectId: "GECKO-0CUONG",
    status: process.env.NODE_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT",
    version: "1.0.0",
    publicKey: process.env.GECKO_RELEASE_PUBLIC_KEY || ""
};

function supportsColor(): boolean {
    if (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS) return false;
    if (process.env.FORCE_COLOR) return true;
    if (process.env.TERM === "dumb") return false;
    if (process.stdout && !process.stdout.isTTY) return false;
    return true;
}

function colorize(str: string, colorCode: string): string {
    if (!supportsColor()) return str;
    return `\x1b[${colorCode}m${str}\x1b[0m`;
}

function printStartupBanner(integrityStatus: string): void {
    const cCyan = (s: string) => colorize(s, "36;1");
    const cGreen = (s: string) => colorize(s, "32;1");
    const cYellow = (s: string) => colorize(s, "33;1");
    const cGray = (s: string) => colorize(s, "90");
    const cWhite = (s: string) => colorize(s, "37;1");

    const logo = `
 ██████╗ ███████╗ ██████╗██╗  ██╗ ██████╗
██╔════╝ ██╔════╝██╔════╝██║ ██╔╝██╔═══██╗
██║  ███╗█████╗  ██║     █████╔╝ ██║   ██║
██║   ██║██╔══╝  ██║     ██╔═██╗ ██║   ██║
╚██████╔╝███████╗╚██████╔╝██║  ██╗╚██████╔╝
 ╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝ `;

    const statusFormatted =
        integrityStatus.startsWith("VERIFIED")
            ? cGreen(integrityStatus)
            : cYellow(integrityStatus);

    console.log(cCyan(logo));
    console.log(cWhite(`           G E C K O   M U S I C   B O T`));
    console.log(cGray(`═════════════════════════════════════════════════════════`));
    console.log(` ${cWhite("Project:")}     ${IDENTITY.project} (${IDENTITY.projectId})`);
    console.log(` ${cWhite("Author:")}      ${IDENTITY.author}`);
    console.log(` ${cWhite("Copyright:")}   ${IDENTITY.copyright}`);
    console.log(` ${cWhite("Repository:")}  ${IDENTITY.repository}`);
    console.log(` ${cWhite("Version:")}     v${IDENTITY.version}`);
    console.log(` ${cWhite("Environment:")} ${process.env.NODE_ENV || "development"}`);
    console.log(` ${cWhite("Node.js:")}     ${process.version}`);
    console.log(` ${cWhite("Process PID:")} ${process.pid}`);
    console.log(` ${cWhite("Startup:")}     ${new Date().toISOString()}`);
    console.log(` ${cWhite("Integrity:")}   ${statusFormatted}`);
    console.log(cGray(`═════════════════════════════════════════════════════════\n`));
}

export interface IntegrityVerificationResult {
    verified: boolean;
    status: string;
    reason: string;
    modifiedFiles: string[];
    details: string[];
}

async function verifyIntegrity(): Promise<IntegrityVerificationResult> {
    try {
        await verifyAndEnsureBinary();
        return {
            verified: true,
            status: "VERIFIED",
            reason: "yt-dlp executable passed the configured integrity gate.",
            modifiedFiles: [],
            details: ["yt-dlp binary integrity verified before startup."]
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (process.env.NODE_ENV === "production") throw new Error("Startup integrity verification failed.");
        return {
            verified: false,
            status: "UNVERIFIED",
            reason: "Development startup continued without a verified release binary.",
            modifiedFiles: [],
            details: [reason]
        };
    }
}

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));

let isReady = false;
let shutdownStarted = false;
let memoryCheckInterval: NodeJS.Timeout | null = null;
let totalErrorCount = 0;
let isIntegrityVerified = false;
let integrityStatusString = "unverified";
const startupTimestamp = Date.now();

function getDiscordStatusString(status: number): string {
    switch (status) {
        case Status.Ready: return "connected";
        case Status.Connecting: return "connecting";
        case Status.Reconnecting: return "reconnecting";
        case Status.Idle: return "idle";
        case Status.Nearly: return "nearly_ready";
        case Status.Disconnected: return "disconnected";
        case Status.WaitingForGuilds: return "waiting_for_guilds";
        case Status.Identifying: return "identifying";
        case Status.Resuming: return "resuming";
        default: return "unknown";
    }
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function isFatalError(err: unknown): boolean {
    if (!err) return false;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
        msg.includes("out of memory") ||
        msg.includes("cannot find module")
    );
}

async function loadCommands(client: GeckoClient): Promise<number> {
    const commandsPath = nodePath.join(__dirname, "commands");
    let fileNames: string[] = [];

    try {
        const dirEntries = await readdir(commandsPath, { withFileTypes: true });
        fileNames = dirEntries
            .filter(
                (entry) =>
                    entry.isFile() &&
                    (entry.name.endsWith(".js") || entry.name.endsWith(".ts")) &&
                    !entry.name.endsWith(".d.ts")
            )
            .map((entry) => entry.name);
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Gecko:Commands] Failed to read commands directory: ${errMsg}`);
        return 0;
    }

    const loadPromises = fileNames.map(async (file) => {
        const commandPath = nodePath.join(commandsPath, file);
        const commandUrl = pathToFileURL(commandPath).href;

        const mod = (await import(commandUrl)) as { default?: SlashCommand };
        const command = mod.default;

        if (
            command &&
            typeof command === "object" &&
            "data" in command &&
            "execute" in command &&
            command.data?.name
        ) {
            client.commands.set(command.data.name, command);
            return command.data.name;
        } else {
            throw new Error(`Invalid command interface in ${file}`);
        }
    });

    const results = await Promise.allSettled(loadPromises);
    let loadedCount = 0;

    results.forEach((res, index) => {
        if (res.status === "fulfilled") {
            loadedCount++;
        } else {
            totalErrorCount++;
            const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
            console.warn(`[Gecko:Commands] Failed to load command '${fileNames[index]}': ${reason}`);
        }
    });

    console.info(`[Gecko:Commands] Loaded ${loadedCount}/${fileNames.length} commands successfully.`);
    return loadedCount;
}

async function loginWithRetry(
    client: GeckoClient,
    token: string,
    maxAttempts = 5
): Promise<void> {
    const delays = [2000, 5000, 10000, 15000, 30000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.info(`[Gecko:Auth] Discord login attempt ${attempt}/${maxAttempts}...`);
        try {
            const loginPromise = client.login(token);
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Login request timed out after 30 seconds")), 30000)
            );

            await Promise.race([loginPromise, timeoutPromise]);
            console.info("[Gecko:Auth] Discord authentication successful.");
            return;
        } catch (err: unknown) {
            totalErrorCount++;
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[Gecko:Auth] Login attempt ${attempt} failed: ${errMsg}`);

            if (errMsg.toLowerCase().includes("invalid token") || errMsg.toLowerCase().includes("disallowed intents")) {
                throw new Error(errMsg);
            }

            if (attempt === maxAttempts) {
                throw new Error(`Exhausted all ${maxAttempts} login attempts. Fatal auth failure.`);
            }

            const waitTime = delays[attempt - 1] || 30000;
            console.info(`[Gecko:Auth] Retrying login in ${waitTime / 1000}s...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
    }
}

function startMemoryProtection(thresholdMB = 600): NodeJS.Timeout {
    return setInterval(() => {
        const mem = process.memoryUsage();
        const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
        const rssMB = Math.round(mem.rss / 1024 / 1024);

        if (heapUsedMB > thresholdMB) {
            console.warn(
                `[Gecko:Memory] High Memory Warning! Heap: ${heapUsedMB}MB / RSS: ${rssMB}MB (Threshold: ${thresholdMB}MB)`
            );
        }
    }, 60000);
}

async function main(): Promise<void> {
    const integrityResult = await verifyIntegrity();

    isIntegrityVerified = integrityResult.verified;
    integrityStatusString = integrityResult.status;

    printStartupBanner(integrityResult.status);

    console.info("[Gecko] Initializing production environment...");

    const hasToken = Boolean(config?.token && typeof config.token === "string" && config.token.trim() !== "");
    if (!hasToken) {
        console.warn("[Gecko:Config] Warning: BOT_TOKEN is missing or empty. Bot login will be deferred until configured in Settings.");
    }

    const client = new GeckoClient();
    client.config = config;

    const port = Number(process.env.PORT) === 8080 ? 3000 : (Number(process.env.PORT) || 3000);
    const server = http.createServer(async (req, res) => {
        try {
            // 1. Control Center REST API & Realtime SSE
            const handledApi = await handleControlCenterApi(req, res, client);
            if (handledApi) return;
            // Handle OPTIONS preflight for public health/metrics
            if (req.method === "OPTIONS" && (req.url === "/healthz" || req.url === "/metrics")) {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    "Access-Control-Max-Age": "86400"
                });
                res.end();
                return;
            }

            if (req.url === "/metrics") {
                res.writeHead(200, {
                    "Content-Type": "text/plain; version=0.0.4",
                    "Access-Control-Allow-Origin": "*"
                });
                const promMetrics = metrics.toPrometheusFormat();

                const customMetrics = [
                    `# HELP gecko_integrity_verified Integrity verification status (1 = verified, 0 = unverified/failed)`,
                    `# TYPE gecko_integrity_verified gauge`,
                    `gecko_integrity_verified ${isIntegrityVerified ? 1 : 0}`,
                    `# HELP gecko_commands_loaded Total loaded slash commands`,
                    `# TYPE gecko_commands_loaded gauge`,
                    `gecko_commands_loaded ${client.commands.size}`,
                    `# HELP gecko_active_queues_total Total active music queues`,
                    `# TYPE gecko_active_queues_total gauge`,
                    `gecko_active_queues_total ${client.queues.size}`,
                    `# HELP gecko_guilds_total Connected Discord guilds`,
                    `# TYPE gecko_guilds_total gauge`,
                    `gecko_guilds_total ${client.guilds.cache.size}`,
                    `# HELP gecko_uptime_seconds Total process uptime in seconds`,
                    `# TYPE gecko_uptime_seconds gauge`,
                    `gecko_uptime_seconds ${Math.floor(process.uptime())}`,
                    `# HELP gecko_memory_heap_used_bytes Heap memory used in bytes`,
                    `# TYPE gecko_memory_heap_used_bytes gauge`,
                    `gecko_memory_heap_used_bytes ${process.memoryUsage().heapUsed}`,
                    `# HELP gecko_errors_total Total error count logged`,
                    `# TYPE gecko_errors_total counter`,
                    `gecko_errors_total ${totalErrorCount}`
                ].join("\n");

                res.end(promMetrics ? `${promMetrics}\n${customMetrics}` : customMetrics);
                return;
            }

            if (req.url === "/healthz") {
                const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
                const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
                const wsStatus = client.ws ? getDiscordStatusString(client.ws.status) : "disconnected";

                let activeVoiceConnections = 0;
                for (const queue of client.queues.values()) {
                    if (queue.connection?.joinConfig.channelId) activeVoiceConnections++;
                }

                const isHealthy = isReady && wsStatus === "connected";
                const healthPayload = {
                    status: isHealthy ? "healthy" : (hasToken ? "connecting" : "awaiting_token"),
                    project: IDENTITY.projectId,
                    copyright: IDENTITY.copyright,
                    integrity: integrityStatusString,
                    discord: wsStatus,
                    guilds: client.guilds.cache.size,
                    queues: client.queues.size,
                    voiceConnections: activeVoiceConnections,
                    memoryMB: heapUsedMB,
                    rssMB: rssMB,
                    uptimeSeconds: Math.floor(process.uptime()),
                    startupState: isReady ? "ready" : "starting"
                };

                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                });
                res.end(JSON.stringify(healthPayload));
                return;
            }

            if (req.url === "/" || req.url === "/index.html") {
                const indexPath = nodePath.resolve(process.cwd(), "index.html");
                if (existsSync(indexPath)) {
                    const html = readFileSync(indexPath, "utf-8");
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(html);
                    return;
                }
            }

            if (req.url === "/" || req.url === "/index.html" || req.url === "/legacy" || req.url === "/dashboard") {
                const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
                const wsStatus = client.ws ? getDiscordStatusString(client.ws.status) : "disconnected";
                const botUser = client.user?.tag || (isReady ? "Đã kết nối" : (hasToken ? `Đang kết nối (${wsStatus})` : "Chưa cấu hình Token"));
                const statusBadgeColor = isReady ? "#22c55e" : (hasToken ? "#eab308" : "#f97316");
                const statusText = isReady ? "TRỰC TUYẾN" : (hasToken ? `CHẾ ĐỘ CHỜ (${wsStatus})` : "CHỜ BOT_TOKEN");

                const commandsList = Array.from(client.commands.values())
                    .map(cmd => `<div style="padding:10px 14px;background:#1e293b;border-radius:6px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
                        <span style="font-weight:600;color:#38bdf8;font-family:monospace;font-size:14px;">/${escapeHtml(cmd.data.name)}</span>
                        <span style="color:#94a3b8;font-size:13px;">${escapeHtml(cmd.data.description || "")}</span>
                    </div>`).join("");

                const html = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gecko Discord Music Bot</title>
    <meta name="description" content="Hệ thống và bot phát nhạc Discord tối giản, tốc độ cao, ổn định với công cụ giám sát sức khỏe tích hợp.">
    <meta property="og:title" content="Gecko Discord Music Bot">
    <meta property="og:description" content="Hệ thống và bot phát nhạc Discord tối giản, tốc độ cao, ổn định với công cụ giám sát sức khỏe tích hợp.">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        body { background: #0b0f19; color: #f8fafc; padding: 32px 16px; display: flex; justify-content: center; }
        .container { max-width: 760px; width: 100%; }
        .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; padding-bottom: 20px; margin-bottom: 24px; }
        .title-group { display: flex; align-items: center; gap: 14px; }
        .badge { padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; background: ${statusBadgeColor}; color: #000; }
        .card { background: #131d2e; border: 1px solid #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .stat-box { background: #0b0f19; padding: 14px; border-radius: 8px; border: 1px solid #1e293b; }
        .stat-box .label { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; letter-spacing: 0.05em; }
        .stat-box .value { font-size: 18px; font-weight: 700; color: #38bdf8; margin-top: 6px; }
        .alert { background: #451a03; border: 1px solid #b45309; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; color: #fef3c7; font-size: 14px; line-height: 1.6; }
        .links { display: flex; gap: 16px; margin-top: 16px; }
        .links a { color: #38bdf8; text-decoration: none; font-size: 13px; font-weight: 500; }
        .links a:hover { text-decoration: underline; }
        code { background: #1e293b; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #facc15; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title-group">
                <span style="font-size:32px;">🦎</span>
                <div>
                    <h1 style="font-size:22px;font-weight:700;">Gecko Music Bot</h1>
                    <p style="font-size:13px;color:#64748b;">${IDENTITY.copyright} &bull; v${IDENTITY.version}</p>
                </div>
            </div>
            <span class="badge">${statusText}</span>
        </div>

        ${!hasToken ? `
        <div class="alert">
            <strong>Yêu cầu cấu hình:</strong> Chưa thiết lập Discord Bot Token.<br/>
            Mở menu <strong>Settings</strong> trong AI Studio để đặt <code>BOT_TOKEN</code>.
        </div>
        ` : ""}

        <div class="stats-grid">
            <div class="stat-box">
                <div class="label">Trạng thái Discord</div>
                <div class="value" style="font-size:14px;color:#f8fafc;">${escapeHtml(botUser)}</div>
            </div>
            <div class="stat-box">
                <div class="label">Máy chủ kết nối</div>
                <div class="value">${client.guilds.cache.size}</div>
            </div>
            <div class="stat-box">
                <div class="label">Hàng đợi hoạt động</div>
                <div class="value">${client.queues.size}</div>
            </div>
            <div class="stat-box">
                <div class="label">Thời gian chạy</div>
                <div class="value">${Math.floor(process.uptime())}s</div>
            </div>
            <div class="stat-box">
                <div class="label">Bộ nhớ (Heap)</div>
                <div class="value">${heapUsedMB} MB</div>
            </div>
            <div class="stat-box">
                <div class="label">Tổng số lệnh</div>
                <div class="value">${client.commands.size}</div>
            </div>
        </div>

        <div class="card">
            <h2 style="font-size:15px;font-weight:600;margin-bottom:14px;color:#e2e8f0;">Danh sách lệnh Slash (${client.commands.size})</h2>
            ${commandsList || '<p style="color:#64748b;font-size:13px;">Không có lệnh slash nào được tải.</p>'}
        </div>

        <div class="links">
            <a href="/healthz">API kiểm tra sức khỏe (/healthz) &rarr;</a>
            <a href="/metrics">Chỉ số Prometheus (/metrics) &rarr;</a>
        </div>
    </div>
</body>
</html>`;
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
                return;
            }

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Gecko Music Bot is online 24/7!");
        } catch (httpErr: unknown) {
            totalErrorCount++;
            const errMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
            console.error(`[Gecko:HTTP] Server request handler error: ${errMsg}`);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal Server Error");
            }
        }
    });

    server.requestTimeout = 10000;
    server.headersTimeout = 11000;
    server.keepAliveTimeout = 5000;
    server.on("error", (err: Error) => {
        totalErrorCount++;
        console.error(`[Gecko:HTTP] Server socket error: ${err.message}`);
    });

    server.listen(port, config.bindHost, () => {
        console.info(`[Gecko:HTTP] Web server listening on http://${config.bindHost}:${port}.`);
    });

    memoryCheckInterval = startMemoryProtection(600);

    await loadCommands(client);

    // yt-dlp integrity was verified before the HTTP server was bound.

    client.on(Events.ShardDisconnect, (event, shardId) => {
        console.warn(`[Gecko:Gateway] Shard ${shardId} disconnected (Code: ${event.code}).`);
        addControlLog("warn", "GATEWAY_DISCONNECT", `Mất kết nối Shard ${shardId} (Mã lỗi: ${event.code})`);
    });

    client.on(Events.ShardReconnecting, (shardId) => {
        console.info(`[Gecko:Gateway] Shard ${shardId} reconnecting to Discord Gateway...`);
        addControlLog("info", "GATEWAY_RECONNECTING", `Shard ${shardId} đang tự động kết nối lại Gateway...`);
    });

    client.on(Events.ShardResume, (shardId, replayedEvents) => {
        console.info(`[Gecko:Gateway] Shard ${shardId} resumed connection. Replayed ${replayedEvents} events.`);
        addControlLog("success", "GATEWAY_RESUMED", `Shard ${shardId} đã phục hồi phiên kết nối (${replayedEvents} sự kiện).`);
    });

    client.on(Events.Error, (err: Error) => {
        totalErrorCount++;
        console.error(`[Gecko:Gateway] WebSocket Client Error: ${err.message}`);
        addControlLog("error", "CLIENT_ERROR", `Lỗi Discord Client: ${err.message}`);
    });

    client.on(Events.GuildCreate, (guild) => {
        addControlLog("info", "GUILD_JOINED", `Bot đã tham gia máy chủ mới: ${guild.name} (${guild.id})`, {
            memberCount: guild.memberCount
        });
    });

    client.on(Events.GuildDelete, (guild) => {
        addControlLog("warn", "GUILD_LEFT", `Bot đã rời khỏi máy chủ: ${guild.name} (${guild.id})`);
    });

    client.once(Events.ClientReady, async (c) => {
        try {
            isReady = true;
            console.info(`[Gecko:Ready] Bot successfully logged in as ${c.user.tag} in ${Date.now() - startupTimestamp}ms.`);
            addControlLog("success", "GATEWAY_READY", `Bot đã trực tuyến và kết nối Discord: ${c.user.tag}`, {
                id: c.user.id,
                tag: c.user.tag,
                guilds: c.guilds.cache.size
            });
            await readyHandler(c as GeckoClient);
        } catch (err: unknown) {
            totalErrorCount++;
            const msg = err instanceof Error ? err.stack || err.message : String(err);
            console.error(`[Gecko:Event:Ready] Error in readyHandler: ${msg}`);
            addControlLog("error", "READY_HANDLER_ERROR", `Lỗi khởi tạo readyHandler: ${msg}`);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isChatInputCommand()) {
            addControlLog("info", "COMMAND_EXECUTED", `Thực thi lệnh /${interaction.commandName} bởi @${interaction.user.tag} trong #${(interaction.channel as any)?.name || "DM"}`);
        }
        try {
            await interactionHandler(interaction, client);
        } catch (err: unknown) {
            totalErrorCount++;
            const msg = err instanceof Error ? err.stack || err.message : String(err);
            console.error(`[Gecko:Event:Interaction] Error in interactionHandler: ${msg}`);
        }
    });

    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
        try {
            await voiceStateUpdateHandler(oldState, newState, client);
        } catch (err: unknown) {
            totalErrorCount++;
            const msg = err instanceof Error ? err.stack || err.message : String(err);
            console.error(`[Gecko:Event:VoiceState] Error in voiceStateUpdateHandler: ${msg}`);
        }
    });

    const shutdown = async (exitCode: number): Promise<void> => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        console.info(`[Gecko:Shutdown] Initiating graceful shutdown (Exit Code: ${exitCode})...`);

        const forceExitTimer = setTimeout(() => {
            console.error("[Gecko:Shutdown] Shutdown timed out after 10s. Forcing exit!");
            process.exit(exitCode);
        }, 10000);
        forceExitTimer.unref();

        try {
            if (memoryCheckInterval) clearInterval(memoryCheckInterval);
            stopAutoUpdater();

            console.info(`[Gecko:Shutdown] Destroying ${client.queues.size} active music queues...`);
            for (const [guildId, queue] of client.queues.entries()) {
                try {
                    queue.destroy();
                } catch (qErr: unknown) {
                    const msg = qErr instanceof Error ? qErr.message : String(qErr);
                    console.error(`[Gecko:Shutdown] Failed to destroy queue for guild ${guildId}: ${msg}`);
                }
            }
            client.queues.clear();

            console.info("[Gecko:Shutdown] Destroying Discord client...");
            client.destroy();

            if (server && server.listening) {
                console.info("[Gecko:Shutdown] Closing HTTP server...");
                await new Promise<void>((resolve) => {
                    server.close((sErr) => {
                        if (sErr) console.error(`[Gecko:Shutdown] HTTP server close error: ${sErr.message}`);
                        resolve();
                    });
                });
            }

            console.info("[Gecko:Shutdown] Graceful cleanup finished.");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.stack || err.message : String(err);
            console.error(`[Gecko:Shutdown] Exception during graceful shutdown: ${msg}`);
        } finally {
            process.exitCode = exitCode;
            process.exit(exitCode);
        }
    };

    process.on("unhandledRejection", (reason: unknown) => {
        totalErrorCount++;
        const errMsg = reason instanceof Error ? reason.stack || reason.message : String(reason);
        console.error(`[Gecko:Error] Unhandled Promise Rejection: ${errMsg}`);

        if (isFatalError(reason)) {
            console.error("[Gecko:Error] Fatal unhandled rejection detected! Initiating emergency shutdown...");
            void shutdown(1);
        } else {
            console.warn("[Gecko:Error] Recoverable rejection intercepted. Process execution continues.");
        }
    });

    process.on("uncaughtException", (err: Error) => {
        totalErrorCount++;
        console.error(`[Gecko:Error] Uncaught Process Exception: ${err.stack || err.message}`);
        console.error("[Gecko:Error] Critical exception! Initiating graceful shutdown...");
        void shutdown(1);
    });

    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));

    if (hasToken && config.token) {
        try {
            await loginWithRetry(client, config.token, 3);
        } catch (authErr: unknown) {
            const msg = authErr instanceof Error ? authErr.message : String(authErr);
            console.warn(`[Gecko:Auth] Discord authentication could not be completed: ${msg}`);
            console.info("[Gecko:HTTP] Web server remains active at http://0.0.0.0:3000 to serve dashboard and health checks.");
        }
    } else {
        console.info("[Gecko:Auth] BOT_TOKEN not configured. Web server is running at http://0.0.0.0:3000.");
    }
}

main().catch((err: unknown) => {
    totalErrorCount++;
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[Gecko:Fatal] Main execution failed: ${errMsg}`);
    process.exit(1);
});