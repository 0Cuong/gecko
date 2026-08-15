export type MusicLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export interface MusicLogContext {
    guildId?: string;
    track?: string;
    operation: string;
    errorType?: string;
    retryCount?: number;
    state?: string;
    error?: Error;
}

/** Small structured logger for the playback hot path. It deliberately never accepts credentials. */
export function logMusic(level: MusicLogLevel, context: MusicLogContext): void {
    if (level === "DEBUG" && process.env.MUSIC_DEBUG !== "true") return;

    const message = sanitizeMessage(context.error?.message);
    const payload = {
        timestamp: new Date().toISOString(),
        guildId: context.guildId,
        track: context.track,
        operation: context.operation,
        errorType: context.errorType,
        retryCount: context.retryCount,
        state: context.state,
        message,
    };
    const write = level === "ERROR" || level === "FATAL" ? console.error : level === "WARN" ? console.warn : console.info;
    write(`[Music][${level}] ${JSON.stringify(payload)}`);
}

function sanitizeMessage(message?: string): string | undefined {
    return message
        ?.replace(/[\r\n]+/g, " ")
        .replace(/https?:\/\/[^\s]+/g, (value) => {
            try {
                const url = new URL(value);
                return `${url.protocol}//${url.hostname}${url.pathname.slice(0, 160)}?[redacted]`;
            } catch {
                return "[url-redacted]";
            }
        })
        .slice(0, 500);
}
