import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodePath from "node:path";
import http from "node:http";
import { Events, Status } from "discord.js";

import { config } from "./config/index.js";
import { GeckoClient } from "./client/GeckoClient.js";
import { downloadExecutable, stopAutoUpdater } from "./utils/ytdlp/index.js";
import type { SlashCommand } from "./client/types.js";
import { metrics } from "./utils/metrics.js";

import readyHandler from "./events/ready.js";
import interactionHandler from "./events/interactionCreate.js";
import voiceStateUpdateHandler from "./events/voiceStateUpdate.js";

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
    console.info("[Gecko:Security] Integrity check bypassed (Disabled)");
    return {
        verified: true,
        status: "DEV BYPASSED",
        reason: "Integrity check disabled",
        modifiedFiles: [],
        details: []
    };
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

function isFatalError(err: unknown): boolean {
    if (!err) return false;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
        msg.includes("token") ||
        msg.includes("disallowed intents") ||
        msg.includes("out of memory") ||
        msg.includes("eaddrinuse") ||
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

    isIntegrityVerified = true;
    integrityStatusString = integrityResult.status;

    printStartupBanner(integrityResult.status);

    console.info("[Gecko] Initializing production environment...");

    if (!config || !config.token || typeof config.token !== "string" || config.token.trim() === "") {
        console.error("[Gecko:Config] Fatal: DISCORD_TOKEN is missing or empty in config!");
        process.exit(1);
    }

    const client = new GeckoClient();
    client.config = config;

    const port = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
        try {
            if (req.url === "/metrics") {
                res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
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
                    status: isHealthy ? "healthy" : "degraded",
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

                res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
                res.end(JSON.stringify(healthPayload));
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

    server.listen(port, () => {
        console.info(`[Gecko:HTTP] Web server listening on port ${port} for keep-alive & health checks.`);
    });

    memoryCheckInterval = startMemoryProtection(600);

    await loadCommands(client);

    void downloadExecutable()
        .then(() => console.info("[Gecko:YTDLP] Binary verification completed in background."))
        .catch((err: unknown) => {
            totalErrorCount++;
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Gecko:YTDLP] Background setup non-fatal warning: ${msg}`);
        });

    client.on(Events.ShardDisconnect, (event, shardId) => {
        console.warn(`[Gecko:Gateway] Shard ${shardId} disconnected (Code: ${event.code}).`);
    });

    client.on(Events.ShardReconnecting, (shardId) => {
        console.info(`[Gecko:Gateway] Shard ${shardId} reconnecting to Discord Gateway...`);
    });

    client.on(Events.ShardResume, (shardId, replayedEvents) => {
        console.info(`[Gecko:Gateway] Shard ${shardId} resumed connection. Replayed ${replayedEvents} events.`);
    });

    client.on(Events.Error, (err: Error) => {
        totalErrorCount++;
        console.error(`[Gecko:Gateway] WebSocket Client Error: ${err.message}`);
    });

    client.once(Events.ClientReady, async (c) => {
        try {
            isReady = true;
            console.info(`[Gecko:Ready] Bot successfully logged in as ${c.user.tag} in ${Date.now() - startupTimestamp}ms.`);
            await readyHandler(c as GeckoClient);
        } catch (err: unknown) {
            totalErrorCount++;
            const msg = err instanceof Error ? err.stack || err.message : String(err);
            console.error(`[Gecko:Event:Ready] Error in readyHandler: ${msg}`);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
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

    await loginWithRetry(client, config.token, 5);
}

main().catch((err: unknown) => {
    totalErrorCount++;
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[Gecko:Fatal] Main execution failed: ${errMsg}`);
    process.exit(1);
});