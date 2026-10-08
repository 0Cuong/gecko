import { URL } from "node:url";
import net from "node:net";
import dns from "node:dns/promises";
import type { GuildMember } from "discord.js";

export interface CooldownOptions {
    userId?: string;
    commandName?: string;
    command?: string;
    key?: string;
    cooldownMs?: number;
    cooldownSec?: number;
    cooldownSeconds?: number;
    cooldown?: number;
    interaction?: any;
}

export class CooldownResult {
    public readonly onCooldown: boolean;
    public readonly limited: boolean;
    public readonly isCooldown: boolean;
    public readonly remaining: number;
    public readonly remainingMs: number;
    public readonly remainingSec: number;
    public readonly cooldownMs: number;
    public readonly resetAt: number;

    constructor(onCooldown: boolean, remainingMs: number, cooldownMs: number, resetAt: number) {
        this.onCooldown = onCooldown;
        this.limited = onCooldown;
        this.isCooldown = onCooldown;
        this.remaining = remainingMs;
        this.remainingMs = remainingMs;
        this.remainingSec = Math.ceil(remainingMs / 1000);
        this.cooldownMs = cooldownMs;
        this.resetAt = resetAt;
    }

    public valueOf(): number {
        return this.remainingMs;
    }

    public [Symbol.toPrimitive](hint: string): boolean | number | string {
        if (hint === "number") return this.remainingMs;
        if (hint === "string") return `${this.remainingSec}s`;
        return this.onCooldown;
    }
}

export class SecurityManager {
    public static readonly MAX_PLAYLIST_SIZE = 100;

    private static readonly cooldowns = new Map<string, number>();
    private static readonly MAX_COOLDOWN_ENTRIES = 10_000;
    private static cleanupTimer: NodeJS.Timeout | null = null;

    static {
        if (typeof setInterval !== "undefined") {
            SecurityManager.cleanupTimer = setInterval(() => {
                SecurityManager.cleanupExpiredCooldowns();
            }, 30_000);

            if (SecurityManager.cleanupTimer && typeof SecurityManager.cleanupTimer.unref === "function") {
                SecurityManager.cleanupTimer.unref();
            }
        }
    }

    /**
     * Kiểm tra một IP có thuộc dải IP nội bộ/riêng tư (RFC 1918, RFC 4193, Loopback, Link-Local) hay không.
     */
    public static isPrivateIp(ip: string): boolean {
        if (!ip || !net.isIP(ip)) return false;
        if (net.isIPv4(ip)) {
            const [a, b, cc] = ip.split(".").map(Number);
            return (
                a === 0 || a === 10 || a === 127 ||
                (a === 100 && b >= 64 && b <= 127) ||
                (a === 169 && b === 254) ||
                (a === 172 && b >= 16 && b <= 31) ||
                (a === 192 && b === 0) ||
                (a === 192 && b === 168) ||
                (a === 198 && (b === 18 || b === 19)) ||
                (a === 198 && b === 51 && cc === 100) ||
                (a === 203 && b === 0 && cc === 113) ||
                a >= 224
            );
        }
        const lower = ip.toLowerCase();
        if (lower.startsWith("::ffff:")) return SecurityManager.isPrivateIp(lower.slice(7));
        return lower === "::" || lower === "::1" ||
            lower.startsWith("fc") || lower.startsWith("fd") ||
            lower.startsWith("fe80:") || lower.startsWith("ff") ||
            lower.startsWith("2001:db8:");
    }

    private static readonly WHITELISTED_DOMAINS = new Set([
        "youtube.com", "youtu.be", "spotify.com", "spotify.link",
        "soundcloud.com", "snd.sc", "tiktok.com", "tikwm.com",
        "ytimg.com", "ggpht.com", "googlevideo.com", "googleusercontent.com",
        "tiktokcdn.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com",
        "sndcdn.com", "scdn.co"
    ]);

    private static extraAllowedDomains(): Set<string> {
        return new Set((process.env.GECKO_ALLOWED_EXTERNAL_HOSTS || "")
            .split(",").map((value) => value.trim().toLowerCase().replace(/^\.+/, "")).filter(Boolean));
    }

    private static hostAllowed(hostname: string): boolean {
        const normalized = hostname.toLowerCase().replace(/\.$/, "");
        const allowed = new Set([...SecurityManager.WHITELISTED_DOMAINS, ...SecurityManager.extraAllowedDomains()]);
        for (const domainName of allowed) {
            if (normalized === domainName || normalized.endsWith("." + domainName)) return true;
        }
        return false;
    }

    /**
     * Validates an HTTP(S) destination and every DNS answer. User-controlled
     * URLs must target an allowlisted external service; derived media URLs may
     * use public-only validation after extraction.
     */
    public static async assertPublicHttpUrl(
        urlStr: string,
        options: { allowUnlistedPublic?: boolean } = {}
    ): Promise<void> {
        if (!urlStr || typeof urlStr !== "string") throw new Error("Invalid or empty URL");
        let parsed: URL;
        try { parsed = new URL(urlStr); } catch { throw new Error("Invalid URL format"); }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Forbidden protocol");
        if (parsed.username || parsed.password) throw new Error("Embedded URL credentials are forbidden");

        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
        if (!hostname) throw new Error("URL hostname is required");

        if (net.isIP(hostname)) {
            if (SecurityManager.isPrivateIp(hostname)) {
                throw new Error("Access to private or reserved IP is forbidden");
            }
            if (!options.allowUnlistedPublic) {
                throw new Error("External destination is not allowlisted");
            }
            return;
        }

        if (!options.allowUnlistedPublic && !SecurityManager.hostAllowed(hostname)) {
            throw new Error("External destination is not allowlisted");
        }

        let addresses: Array<{ address: string }>;
        try {
            addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch {
            throw new Error("Destination DNS resolution failed");
        }
        if (!addresses.length) throw new Error("Destination has no DNS answers");
        for (const addr of addresses) {
            if (SecurityManager.isPrivateIp(addr.address)) {
                throw new Error("Destination resolves to private or reserved IP");
            }
        }
    }

    /**
     * Production Discord Bot Cooldown System.
     * Supports slash commands, interactionCreate events, user IDs, command names, options objects, and seconds/milliseconds.
     */
    public static checkCooldown(
        target: any,
        commandOrCooldown?: any,
        cooldownMsOrSec?: number,
        scope?: string
    ): CooldownResult {
        const { userId, commandName, cooldownMs } = SecurityManager.parseCooldownArgs(
            target,
            commandOrCooldown,
            cooldownMsOrSec
        );

        const scopeId = SecurityManager.normalizeScope(scope ?? SecurityManager.extractScope(target));
        const key = `${scopeId}:${userId}:${commandName}`;
        const now = Date.now();
        const existingExpiry = SecurityManager.cooldowns.get(key);

        if (existingExpiry !== undefined && now < existingExpiry) {
            const remainingMs = existingExpiry - now;
            return new CooldownResult(true, remainingMs, cooldownMs, existingExpiry);
        }

        const newExpiry = now + cooldownMs;
        if (cooldownMs > 0) {
            SecurityManager.setCooldownEntry(key, newExpiry);
        }

        return new CooldownResult(false, 0, cooldownMs, newExpiry);
    }

    /**
     * Retrieves remaining cooldown in milliseconds without setting or modifying state.
     */
    public static getRemainingCooldown(target: any, commandOrCooldown?: any, scope?: string): number {
        const { userId, commandName } = SecurityManager.parseCooldownArgs(target, commandOrCooldown);
        const scopeId = SecurityManager.normalizeScope(scope ?? SecurityManager.extractScope(target));
        const key = `${scopeId}:${userId}:${commandName}`;
        const existingExpiry = SecurityManager.cooldowns.get(key);
        if (!existingExpiry) return 0;
        const remaining = existingExpiry - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    /**
     * Checks if a user or interaction is currently on cooldown without modifying state.
     */
    public static isOnCooldown(target: any, commandOrCooldown?: any, scope?: string): boolean {
        return SecurityManager.getRemainingCooldown(target, commandOrCooldown, scope) > 0;
    }

    /**
     * Resets the cooldown for a specific user and command.
     */
    public static resetCooldown(target: any, commandOrCooldown?: any, scope?: string): boolean {
        const { userId, commandName } = SecurityManager.parseCooldownArgs(target, commandOrCooldown);
        const scopeId = SecurityManager.normalizeScope(scope ?? SecurityManager.extractScope(target));
        const key = `${scopeId}:${userId}:${commandName}`;
        return SecurityManager.cooldowns.delete(key);
    }

    /**
     * Clears all active cooldown entries.
     */
    public static clearAllCooldowns(): void {
        SecurityManager.cooldowns.clear();
    }

    /**
     * Automatic / Manual sweep of expired cooldown entries to prevent memory leaks.
     */
    public static cleanupExpiredCooldowns(): number {
        const now = Date.now();
        let deletedCount = 0;
        for (const [key, expiry] of SecurityManager.cooldowns.entries()) {
            if (now >= expiry) {
                SecurityManager.cooldowns.delete(key);
                deletedCount++;
            }
        }
        return deletedCount;
    }

    // Instance method wrappers to guarantee callers can call methods on instance references
    public get MAX_PLAYLIST_SIZE(): number {
        return SecurityManager.MAX_PLAYLIST_SIZE;
    }

    public isPrivateIp(ip: string): boolean {
        return SecurityManager.isPrivateIp(ip);
    }

    public assertPublicHttpUrl(
        urlStr: string,
        options: { allowUnlistedPublic?: boolean } = {}
    ): Promise<void> {
        return SecurityManager.assertPublicHttpUrl(urlStr, options);
    }

    public checkCooldown(
        target: any,
        commandOrCooldown?: any,
        cooldownMsOrSec?: number,
        scope?: string
    ): CooldownResult {
        return SecurityManager.checkCooldown(target, commandOrCooldown, cooldownMsOrSec, scope);
    }

    public getRemainingCooldown(target: any, commandOrCooldown?: any, scope?: string): number {
        return SecurityManager.getRemainingCooldown(target, commandOrCooldown, scope);
    }

    public isOnCooldown(target: any, commandOrCooldown?: any, scope?: string): boolean {
        return SecurityManager.isOnCooldown(target, commandOrCooldown, scope);
    }

    public resetCooldown(target: any, commandOrCooldown?: any, scope?: string): boolean {
        return SecurityManager.resetCooldown(target, commandOrCooldown, scope);
    }

    public clearAllCooldowns(): void {
        SecurityManager.clearAllCooldowns();
    }

    public cleanupExpiredCooldowns(): number {
        return SecurityManager.cleanupExpiredCooldowns();
    }

    private static setCooldownEntry(key: string, expiry: number): void {
        if (SecurityManager.cooldowns.size >= SecurityManager.MAX_COOLDOWN_ENTRIES) {
            SecurityManager.cleanupExpiredCooldowns();
            if (SecurityManager.cooldowns.size >= SecurityManager.MAX_COOLDOWN_ENTRIES) {
                const firstKey = SecurityManager.cooldowns.keys().next().value;
                if (firstKey !== undefined) {
                    SecurityManager.cooldowns.delete(firstKey);
                }
            }
        }
        SecurityManager.cooldowns.set(key, expiry);
    }

    private static parseCooldownArgs(
        target: any,
        commandOrCooldown?: any,
        cooldownMsOrSec?: number
    ): { userId: string; commandName: string; cooldownMs: number } {
        let userId = "global_user";
        let commandName = "global_command";
        let rawCooldown: number | undefined = undefined;

        const DEFAULT_COOLDOWN_MS = 3000;

        if (
            typeof target === "object" &&
            target !== null &&
            !target.user &&
            !target.member &&
            !target.author &&
            (target.userId || target.commandName || target.key || target.cooldownMs || target.cooldownSec || target.interaction)
        ) {
            const opts = target as CooldownOptions;
            if (opts.interaction) {
                userId = SecurityManager.extractUserId(opts.interaction) || opts.userId || "global_user";
                commandName = opts.commandName || opts.command || SecurityManager.extractCommandName(opts.interaction);
            } else {
                userId = opts.userId || opts.key || "global_user";
                commandName = opts.commandName || opts.command || "global_command";
            }
            rawCooldown = opts.cooldownMs ?? ((opts.cooldownSec ?? opts.cooldownSeconds) !== undefined ? (opts.cooldownSec ?? opts.cooldownSeconds)! * 1000 : opts.cooldown);
        } else if (typeof target === "object" && target !== null) {
            userId = SecurityManager.extractUserId(target) || "global_user";

            if (typeof commandOrCooldown === "string") {
                commandName = commandOrCooldown;
                rawCooldown = cooldownMsOrSec;
            } else if (typeof commandOrCooldown === "number") {
                commandName = SecurityManager.extractCommandName(target);
                rawCooldown = commandOrCooldown;
            } else {
                commandName = SecurityManager.extractCommandName(target);
                rawCooldown = cooldownMsOrSec;
            }
        } else if (typeof target === "string") {
            userId = target;

            if (typeof commandOrCooldown === "string") {
                commandName = commandOrCooldown;
                rawCooldown = cooldownMsOrSec;
            } else if (typeof commandOrCooldown === "number") {
                commandName = "global_command";
                rawCooldown = commandOrCooldown;
            } else {
                commandName = "global_command";
                rawCooldown = cooldownMsOrSec;
            }
        }

        const cooldownMs = SecurityManager.normalizeCooldownMs(rawCooldown, DEFAULT_COOLDOWN_MS);
        return { userId, commandName, cooldownMs };
    }

    private static extractScope(target: any): string {
        if (!target || typeof target !== "object") return "global";
        if (typeof target.guildId === "string" && target.guildId) return target.guildId;
        if (typeof target.guild?.id === "string" && target.guild.id) return target.guild.id;
        if (typeof target.channelId === "string" && target.channelId) return target.channelId;
        return "global";
    }

    private static normalizeScope(scope: string | undefined): string {
        const value = (scope || "global").trim();
        return value || "global";
    }

    private static extractUserId(target: any): string | null {
        if (!target) return null;
        if (typeof target === "string") return target;
        if (target.user && typeof target.user.id === "string") {
            return target.user.id;
        }
        if (target.member?.user && typeof target.member.user.id === "string") {
            return target.member.user.id;
        }
        if (target.author && typeof target.author.id === "string") {
            return target.author.id;
        }
        if (typeof target.id === "string") {
            return target.id;
        }
        return null;
    }

    private static extractCommandName(target: any): string {
        if (!target) return "default";
        if (typeof target === "string") return target;
        if (typeof target.commandName === "string" && target.commandName) {
            return target.commandName;
        }
        if (typeof target.customId === "string" && target.customId) {
            return target.customId;
        }
        if (typeof target.name === "string" && target.name) {
            return target.name;
        }
        if (typeof target.id === "string" && target.id) {
            return target.id;
        }
        return "default";
    }

    private static normalizeCooldownMs(rawVal: number | undefined, defaultMs: number): number {
        if (rawVal === undefined || rawVal === null || Number.isNaN(rawVal)) {
            return defaultMs;
        }
        if (rawVal <= 0) return 0;
        if (rawVal <= 300) {
            return Math.round(rawVal * 1000);
        }
        return Math.round(rawVal);
    }
}

export const securityManager = SecurityManager;

/**
 * Validates that an interaction member is connected to the same voice channel as the bot queue.
 */
export function assertSameVoiceChannel(
    member: GuildMember | null | undefined,
    queue: { connection: { joinConfig: { channelId: string | null } } | null } | null | undefined
): boolean {
    if (!member || !queue || !queue.connection) return false;
    const voiceChannel = member.voice?.channel;
    const botChannelId = queue.connection.joinConfig.channelId;
    if (!voiceChannel || !botChannelId || voiceChannel.id !== botChannelId) {
        return false;
    }
    return true;
}

/**
 * Sanitizes errors before presenting them to Discord users to prevent internal path,
 * stack frame, environment variable, or token leakage.
 */
export function sanitizeUserErrorMessage(err: unknown): string {
    if (!err) return "An unexpected error occurred.";
    const rawMsg = err instanceof Error ? err.message : String(err);

    // Detect internal system or secret leak signatures
    if (
        /(\/[a-zA-Z0-9_.-]+){3,}/.test(rawMsg) ||
        /[a-zA-Z]:\\[a-zA-Z0-9_.\\]+/.test(rawMsg) ||
        /at\s+[a-zA-Z0-9_$.]+\s+\(/i.test(rawMsg) ||
        /token|secret|password|authorization|private_key/i.test(rawMsg)
    ) {
        return "An internal error occurred while processing this request.";
    }

    // Strip raw terminal/ANSI formatting
    const clean = rawMsg.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim();
    if (clean.length > 200) {
        return clean.slice(0, 197) + "...";
    }
    return clean || "An unexpected error occurred.";
}
