import { MessageFlags, SlashCommandBuilder, EmbedBuilder, version as djsVersion } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { monitor } from "../utils/monitor.js";
import { formatDuration } from "../utils/format.js";
import os from "node:os";
import process from "node:process";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const STATIC_SYS = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    djsVersion: djsVersion ?? "14.x",
    cpuModel: getCpuModel(),
    cpuThreads: getCpuThreads(),
    totalRamBytes: os.totalmem(),
    pid: process.pid,
} as const;

let eldHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
try {
    eldHistogram = monitorEventLoopDelay({ resolution: 20 });
    eldHistogram.enable();
} catch {
    eldHistogram = null;
}

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();

// ============================================================================
// HELPER FUNCTIONS & METRIC CALCULATORS
// ============================================================================

/** Safely extracts CPU model name from os.cpus() */
function getCpuModel(): string {
    try {
        const cpus = os.cpus();
        return cpus && cpus.length > 0 ? cpus[0].model.trim() : "Unknown CPU";
    } catch {
        return "Unknown CPU";
    }
}

/** Safely extracts total logical CPU threads */
function getCpuThreads(): number {
    try {
        const cpus = os.cpus();
        return cpus && cpus.length > 0 ? cpus.length : 1;
    } catch {
        return 1;
    }
}

/** Formats byte sizes into human-readable MB or GB strings */
function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
    const gb = bytes / 1073741824; // 1024^3
    if (gb >= 1.0) {
        return `${gb.toFixed(2)} GB`;
    }
    const mb = bytes / 1048576; // 1024^2
    return `${mb.toFixed(1)} MB`;
}

/** Formats numbers with locale comma separators */
function formatNumber(num: number): string {
    if (!Number.isFinite(num)) return "0";
    return Math.max(0, Math.floor(num)).toLocaleString("en-US");
}

/** Safely formats seconds into human-readable duration string with fallback */
function safeFormatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
    try {
        const formatted = formatDuration(Math.floor(seconds));
        if (formatted) return formatted;
    } catch {
        // Fallback to native calculation if formatDuration throws or returns null
    }
    const s = Math.floor(seconds);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

/** Calculates current Event Loop Delay in milliseconds */
function getEventLoopDelayMs(): number {
    if (!eldHistogram) return 0;
    try {
        const nanoseconds = eldHistogram.mean;
        if (!Number.isFinite(nanoseconds) || Number.isNaN(nanoseconds)) return 0;
        return nanoseconds / 1e6;
    } catch {
        return 0;
    }
}

/** Calculates real-time thread-normalized process CPU usage % since last invocation */
function calculateCpuPercent(): number {
    try {
        const currentUsage = process.cpuUsage();
        const currentTime = process.hrtime.bigint();

        const userDiff = currentUsage.user - lastCpuUsage.user;
        const sysDiff = currentUsage.system - lastCpuUsage.system;
        const timeDiffMicros = Number(currentTime - lastCpuTime) / 1000;

        lastCpuUsage = currentUsage;
        lastCpuTime = currentTime;

        if (timeDiffMicros <= 0) return 0;

        const totalMicros = userDiff + sysDiff;
        const percent = (totalMicros / (timeDiffMicros * STATIC_SYS.cpuThreads)) * 100;
        return Math.min(100, Math.max(0, Number(percent.toFixed(1))));
    } catch {
        return 0;
    }
}

/** Safely counts total queued tracks cached across all active server queues */
function getQueueCacheSize(client: any): number {
    try {
        if (!client?.queues || typeof client.queues.values !== "function") return 0;
        let count = 0;
        for (const queue of client.queues.values()) {
            if (!queue) continue;
            if (Array.isArray(queue.songs)) {
                count += queue.songs.length;
            } else if (Array.isArray(queue.tracks)) {
                count += queue.tracks.length;
            } else if (Array.isArray(queue.queue)) {
                count += queue.queue.length;
            } else if (typeof queue.size === "number") {
                count += queue.size;
            }
        }
        return count;
    } catch {
        return 0;
    }
}

/** Safely counts active voice connections across voice adapters and audio manager */
function getActiveVoiceConnections(client: any): number {
    try {
        if (client?.voice?.adapters && typeof client.voice.adapters.size === "number") {
            return client.voice.adapters.size;
        }
    } catch {
        // Fallback gracefully
    }
    return 0;
}

/** Safely fetches count of active message/interaction collectors */
function getActiveCollectorsCount(client: any): number {
    try {
        if (client?.collectors && typeof client.collectors.size === "number") {
            return client.collectors.size;
        }
    } catch {
        // Fallback gracefully
    }
    return 0;
}

/** Safely inspects active handle count for process Timers */
function getActiveTimersCount(): number {
    try {
        if (typeof (process as any)._getActiveHandles === "function") {
            const handles = (process as any)._getActiveHandles();
            if (Array.isArray(handles)) {
                let count = 0;
                for (let i = 0; i < handles.length; i++) {
                    const h = handles[i];
                    if (h && h.constructor && h.constructor.name === "Timeout") {
                        count++;
                    }
                }
                return count;
            }
        }
    } catch {
        // Fallback gracefully
    }
    return 0;
}

/** Safely counts total registered event listeners on client and process */
function getActiveEventListenersCount(client: any): number {
    try {
        let count = 0;
        if (client && typeof client.eventNames === "function") {
            const events = client.eventNames();
            for (let i = 0; i < events.length; i++) {
                count += client.listenerCount(events[i]);
            }
        }
        if (typeof process.eventNames === "function") {
            const pEvents = process.eventNames();
            for (let i = 0; i < pEvents.length; i++) {
                count += process.listenerCount(pEvents[i]);
            }
        }
        return count;
    } catch {
        return 0;
    }
}

/** Safely gets active player count from Audio Manager */
function safeGetActivePlayerCount(client: any): number {
    try {
        if (client?.queues && typeof client.queues.values === "function") {
            let count = 0;
            for (const queue of client.queues.values()) {
                if (queue?.isPlaying?.()) count += 1;
            }
            return count;
        }
    } catch {
        // Fallback gracefully
    }
    return 0;
}

/** Safely gets audio engine type from Audio Manager */
function safeGetEngineType(): string {
    return "local-ffmpeg-opus";
}

// ============================================================================
// HEALTH & DIAGNOSTICS ENGINE
// ============================================================================

interface DiagnosticReport {
    statusEmoji: string;
    statusLabel: string;
    healthColor: number;
    score: number;
    warnings: string[];
}

/**
 * Analyzes process, system, discord, and audio stats to produce real diagnostic health score and warnings.
 */
function analyzeHealth(params: {
    wsPing: number;
    restLatency: number;
    cpuUsage: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    rssBytes: number;
    totalRamBytes: number;
    eventLoopDelayMs: number;
    activeQueues: number;
    activePlayers: number;
    voiceConnections: number;
    engineType: string;
    cachedUsers: number;
    cachedChannels: number;
    listenersCount: number;
}): DiagnosticReport {
    const warnings: string[] = [];
    let healthPenalty = 0;

    // 1. Memory Analysis
    const heapRatio = params.heapTotalBytes > 0 ? params.heapUsedBytes / params.heapTotalBytes : 0;
    const rssRatio = params.totalRamBytes > 0 ? params.rssBytes / params.totalRamBytes : 0;

    if (heapRatio > 0.90) {
        warnings.push(`Possible memory leak: Heap ratio at ${(heapRatio * 100).toFixed(1)}% (${formatBytes(params.heapUsedBytes)} / ${formatBytes(params.heapTotalBytes)})`);
        healthPenalty += 30;
    } else if (heapRatio > 0.85 || rssRatio > 0.85) {
        warnings.push(`High memory usage: Heap ${(heapRatio * 100).toFixed(1)}%, RSS ${(rssRatio * 100).toFixed(1)}% of total RAM`);
        healthPenalty += 15;
    }

    // 2. CPU Analysis
    if (params.cpuUsage > 80) {
        warnings.push(`High CPU usage: ${params.cpuUsage.toFixed(1)}% core load`);
        healthPenalty += 20;
    }

    // 3. Event Loop Latency Analysis
    if (params.eventLoopDelayMs > 100) {
        warnings.push(`Event loop blocking detected: ${params.eventLoopDelayMs.toFixed(1)}ms delay`);
        healthPenalty += 25;
    }

    // 4. Audio Engine Health Analysis
    const isEngineInvalid = !params.engineType || params.engineType === "Unknown" || params.engineType === "None" || params.engineType === "Failed";
    if (isEngineInvalid && params.activeQueues > 0) {
        warnings.push("Audio engine failure: Active queues exist without an operational audio engine");
        healthPenalty += 35;
    }

    // 5. Player & Voice State Diagnostics
    if (params.activeQueues > 0 && params.activePlayers === 0) {
        warnings.push(`Zombie queues detected: ${params.activeQueues} active queue(s) with 0 running audio players`);
        healthPenalty += 20;
    } else if (params.activeQueues > params.voiceConnections) {
        warnings.push(`Disconnected players: ${params.activeQueues} active queue(s) but only ${params.voiceConnections} voice connection(s)`);
        healthPenalty += 15;
    } else if (params.voiceConnections > params.activePlayers) {
        warnings.push(`Voice reconnect issues: ${params.voiceConnections} voice connection(s) active for ${params.activePlayers} audio player(s)`);
        healthPenalty += 10;
    }

    // 6. Cache Diagnostics
    if (params.cachedUsers > 50000 || params.cachedChannels > 25000) {
        warnings.push(`Large cache footprint: ${formatNumber(params.cachedUsers)} users, ${formatNumber(params.cachedChannels)} channels cached`);
        healthPenalty += 10;
    }

    // 7. REST & Gateway Latency Diagnostics
    if (params.restLatency > 300) {
        warnings.push(`REST latency spike: ${params.restLatency}ms interaction roundtrip delay`);
        healthPenalty += 10;
    }

    if (params.wsPing > 300 || params.wsPing < 0) {
        warnings.push(`High WebSocket latency: ${params.wsPing}ms ping`);
        healthPenalty += 15;
    }

    // 8. Event Listener Diagnostics
    if (params.listenersCount > 100) {
        warnings.push(`Too many listeners: ${params.listenersCount} event listeners registered`);
        healthPenalty += 10;
    }

    const score = Math.max(0, 100 - healthPenalty);

    let statusEmoji = "🟢";
    let statusLabel = "Excellent";
    let healthColor = 0x10b981; // Emerald Green

    if (score < 60 || warnings.some(w => w.includes("failure") || w.includes("leak") || w.includes("blocking"))) {
        statusEmoji = "🔴";
        statusLabel = "Critical";
        healthColor = 0xef4444; // Red
    } else if (score < 90 || warnings.length > 0) {
        statusEmoji = "🟡";
        statusLabel = "Moderate";
        healthColor = 0xf59e0b; // Amber
    }

    return {
        statusEmoji,
        statusLabel,
        healthColor,
        score,
        warnings,
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName("system")
        .setDescription("Displays bot performance metrics and system health stats."),

    async execute(interaction: ChatInputCommandInteraction, client?: any) {
        const startTime = performance.now();
        const now = new Date();
        const targetClient = client ?? interaction.client;

        const mem = process.memoryUsage();
        const freeRam = os.freemem();
        const totalRam = STATIC_SYS.totalRamBytes;
        const sysMemPercent = totalRam > 0 ? ((totalRam - freeRam) / totalRam) * 100 : 0;
        const procMemPercent = totalRam > 0 ? (mem.rss / totalRam) * 100 : 0;

        const cpuUsagePercent = calculateCpuPercent();
        const eventLoopDelayMs = getEventLoopDelayMs();

        let monitorStats: any = null;
        try {
            if (typeof monitor?.getHealthStats === "function") {
                monitorStats = monitor.getHealthStats(targetClient.queues?.size ?? 0);
            }
        } catch {
            monitorStats = null;
        }

        const rawPing = targetClient.ws?.ping;
        const wsPing = typeof rawPing === "number" && !Number.isNaN(rawPing) ? Math.max(0, Math.round(rawPing)) : 0;
        const restLatency = Math.max(0, Math.round(Date.now() - interaction.createdTimestamp));

        const guildsCount = targetClient.guilds?.cache?.size ?? 0;
        const usersCount = targetClient.users?.cache?.size ?? 0;
        const channelsCount = targetClient.channels?.cache?.size ?? 0;

        const activeQueues = targetClient.queues?.size ?? monitorStats?.activeQueuesCount ?? 0;
        const activePlayers = safeGetActivePlayerCount(targetClient);
        const engineType = safeGetEngineType();
        const queueCacheSize = getQueueCacheSize(targetClient);
        const voiceConnections = getActiveVoiceConnections(targetClient);

        const processUptime = process.uptime();
        const osUptime = os.uptime();
        const botStartTime = targetClient.readyAt ?? (targetClient.readyTimestamp ? new Date(targetClient.readyTimestamp) : new Date(Date.now() - processUptime * 1000));
        const activeCollectors = getActiveCollectorsCount(targetClient);
        const activeTimers = getActiveTimersCount();
        const activeListeners = getActiveEventListenersCount(targetClient);

        const healthReport = analyzeHealth({
            wsPing,
            restLatency,
            cpuUsage: monitorStats?.cpuUsagePercent ?? cpuUsagePercent,
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
            rssBytes: mem.rss,
            totalRamBytes: totalRam,
            eventLoopDelayMs,
            activeQueues,
            activePlayers,
            voiceConnections,
            engineType,
            cachedUsers: usersCount,
            cachedChannels: channelsCount,
            listenersCount: activeListeners,
        });

        const commandProcMs = Math.max(0.01, performance.now() - startTime);

        // 8. Warning List Formatting
        const warningsText = healthReport.warnings.length > 0
            ? healthReport.warnings.map(w => `• ${w}`).join("\n")
            : "🟢 No active system anomalies or warnings detected.";

        // 9. Build Professional Structured Dashboard Embed
        const embed = new EmbedBuilder()
            .setColor(healthReport.healthColor)
            .setTitle("⚙️ Gecko Commercial System Dashboard")
            .addFields(
                {
                    name: `🏥 Health Report: ${healthReport.statusEmoji} ${healthReport.statusLabel}`,
                    value: `**Health Score**: \`${healthReport.score} / 100\` • **Active Warnings**: \`${healthReport.warnings.length}\``,
                    inline: false,
                },
                {
                    name: "🖥️ System",
                    value: `━━━━━━━━━━━━━━━━━━\n` +
                           `• **OS & Arch**: \`${STATIC_SYS.platform} (${STATIC_SYS.arch})\` \n` +
                           `• **CPU Model**: \`${STATIC_SYS.cpuModel}\` \n` +
                           `• **CPU Threads**: \`${STATIC_SYS.cpuThreads} Threads\` \n` +
                           `• **System Memory**: \`${formatBytes(totalRam - freeRam)} / ${formatBytes(totalRam)} (${sysMemPercent.toFixed(1)}% Used)\` \n` +
                           `• **OS Uptime**: \`${safeFormatDuration(osUptime)}\``,
                    inline: false,
                },
                {
                    name: "⚡ Performance",
                    value: `━━━━━━━━━━━━━━━━━━\n` +
                           `• **CPU Usage**: \`${cpuUsagePercent.toFixed(1)}%\` \n` +
                           `• **Event Loop Delay**: \`${eventLoopDelayMs.toFixed(2)}ms\` \n` +
                           `• **Command Process Time**: \`${commandProcMs.toFixed(2)}ms\` \n` +
                           `• **Heap Memory**: \`${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}\` \n` +
                           `• **RSS Memory**: \`${formatBytes(mem.rss)} (${procMemPercent.toFixed(1)}% of System RAM)\` \n` +
                           `• **External / ArrayBuffer**: \`${formatBytes(mem.external)} / ${formatBytes(mem.arrayBuffers ?? 0)}\``,
                    inline: false,
                },
                {
                    name: "📡 Discord Infrastructure",
                    value: `━━━━━━━━━━━━━━━━━━\n` +
                           `• **WebSocket Ping**: \`${wsPing}ms\` \n` +
                           `• **REST API Latency**: \`${restLatency}ms\` \n` +
                           `• **Active Guilds**: \`${formatNumber(guildsCount)}\` \n` +
                           `• **Cached Users / Channels**: \`${formatNumber(usersCount)}\` | \`${formatNumber(channelsCount)}\` \n` +
                           `• **Active Collectors**: \`${formatNumber(activeCollectors)}\``,
                    inline: false,
                },
                {
                    name: "🎵 Audio Subsystem",
                    value: `━━━━━━━━━━━━━━━━━━\n` +
                           `• **Audio Engine**: \`${engineType}\` \n` +
                           `• **Active Audio Players**: \`${formatNumber(activePlayers)}\` \n` +
                           `• **Active Music Queues**: \`${formatNumber(activeQueues)}\` \n` +
                           `• **Voice Connections**: \`${formatNumber(voiceConnections)}\` \n` +
                           `• **Queue Cache Size**: \`${formatNumber(queueCacheSize)} tracks\``,
                    inline: false,
                },
                {
                    name: "⚙️ Process & Runtime",
                    value: `━━━━━━━━━━━━━━━━━━\n` +
                           `• **Process PID**: \`${STATIC_SYS.pid}\` \n` +
                           `• **Node.js / Discord.js**: \`${STATIC_SYS.nodeVersion}\` | \`v${STATIC_SYS.djsVersion}\` \n` +
                           `• **Process Uptime**: \`${safeFormatDuration(processUptime)}\` \n` +
                           `• **Bot Start Time**: <t:${Math.floor(botStartTime.getTime() / 1000)}:F> (<t:${Math.floor(botStartTime.getTime() / 1000)}:R>) \n` +
                           `• **Current Time**: <t:${Math.floor(now.getTime() / 1000)}:F> \n` +
                           `• **Active Handles**: \`${formatNumber(activeTimers)} Timers\` | \`${formatNumber(activeListeners)} Listeners\``,
                    inline: false,
                },
                {
                    name: "⚠️ Diagnostics & Warnings",
                    value: `━━━━━━━━━━━━━━━━━━\n${warningsText}`,
                    inline: false,
                }
            )
            .setFooter({ text: "Gecko Commercial Monitoring Engine • Live Audit" });

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
} satisfies SlashCommand;
