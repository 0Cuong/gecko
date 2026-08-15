import process from "node:process";

function required(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
}

function optional(key: string, fallback: string): string {
    return process.env[key] || fallback;
}

function positiveInteger(key: string, fallback: number, minimum: number, maximum: number): number {
    const parsed = Number(optional(key, String(fallback)));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export const config = {
    token: required("BOT_TOKEN"),
    devGuildId: optional("DEV_GUILD_ID", ""),
    defaultVolume: positiveInteger("DEFAULT_VOLUME", 100, 1, 200),
    idleTimeout: positiveInteger("IDLE_TIMEOUT", 300, 30, 86_400) * 1_000,
    emptyVoiceTimeout: positiveInteger("EMPTY_VOICE_TIMEOUT", 180, 30, 86_400) * 1_000,
    maxQueueSize: positiveInteger("MAX_QUEUE_SIZE", 500, 1, 2_000),
    maxPlaylistSize: positiveInteger("MAX_PLAYLIST_SIZE", 100, 1, 500),
} as const;

export type GeckoConfig = typeof config;
