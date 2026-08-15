export type RetryStrategy = "stream-refresh" | "network" | "rate-limit" | "ffmpeg" | "authentication" | "fatal";

export interface RetryDecision {
    retry: boolean;
    attempt: number;
    delayMs: number;
    reason: string;
    strategy: RetryStrategy;
    /** A retry must resolve a new stream URL instead of replaying a known-bad one. */
    refreshStream: boolean;
}

export const MAX_STREAM_RETRY = 3;
export const MAX_FFMPEG_RESTART = 2;

const FATAL_ERROR_REGEX = /(?:\b(?:400|404|410)\b|age[- ]restricted|private|deleted|invalid (?:url|media)|malformed|copyright|removed by user|(?:video|resource|media) unavailable|geo-restricted|live stream has ended)/i;
const AUTH_ERROR_REGEX = /(?:\b401\b|login required|sign in to confirm|authentication|authorization)/i;
const STREAM_REFRESH_REGEX = /(?:\b403\b|forbidden|expired|signature|access denied|media validation)/i;
const RATE_LIMIT_REGEX = /(?:\b429\b|rate limit|too many requests)/i;
const FFMPEG_REGEX = /(?:ffmpeg|invalid data found|decoder|demux|conversion failed|exited [1-9])/i;
const NETWORK_REGEX = /(?:\b(?:500|502|503|504)\b|econnreset|epipe|etimedout|econnrefused|enotfound|eai_again|network|socket|timeout|pipe closed|premature close|connection reset|broken pipe)/i;

export function classifyErrorStrategy(error: Error): { strategy: RetryStrategy; reason: string } {
    const message = error.message || "";
    if (FATAL_ERROR_REGEX.test(message)) return { strategy: "fatal", reason: "Invalid, removed, or permanently unavailable media" };
    if (AUTH_ERROR_REGEX.test(message)) return { strategy: "authentication", reason: "Source session or authentication is required" };
    if (RATE_LIMIT_REGEX.test(message)) return { strategy: "rate-limit", reason: "Source rate limit" };
    if (STREAM_REFRESH_REGEX.test(message)) return { strategy: "stream-refresh", reason: "Expired or denied direct media URL" };
    if (FFMPEG_REGEX.test(message)) return { strategy: "ffmpeg", reason: "FFmpeg transport or decode failure" };
    if (NETWORK_REGEX.test(message)) return { strategy: "network", reason: "Transient network failure" };
    return { strategy: "stream-refresh", reason: "Unknown playback failure; resolving a fresh stream once" };
}

export function isRecoverablePlaybackError(error: Error): boolean {
    return classifyErrorStrategy(error).strategy !== "fatal";
}

export class RetryManager {
    private trackId: string | null = null;
    private attempts = 0;
    private ffmpegAttempts = 0;

    public reset(trackId?: string): void {
        this.trackId = trackId ?? null;
        this.attempts = 0;
        this.ffmpegAttempts = 0;
    }

    public next(trackId: string, error: Error): RetryDecision {
        if (this.trackId !== trackId) this.reset(trackId);
        const { strategy, reason } = classifyErrorStrategy(error);

        if (strategy === "fatal") return this.noRetry(strategy, reason);

        if (strategy === "ffmpeg") {
            if (this.ffmpegAttempts >= MAX_FFMPEG_RESTART) return this.noRetry(strategy, reason);
            this.ffmpegAttempts += 1;
            this.attempts += 1;
            return this.decision(strategy, reason, this.ffmpegAttempts, exponentialDelay(this.ffmpegAttempts, 500), true);
        }

        // One forced re-extraction gives a source adapter a chance to refresh its session.
        if (strategy === "authentication") {
            if (this.attempts >= 1) return this.noRetry(strategy, reason);
            this.attempts += 1;
            return this.decision(strategy, reason, this.attempts, 1_000, true);
        }

        if (this.attempts >= MAX_STREAM_RETRY) return this.noRetry(strategy, reason);
        this.attempts += 1;
        const base = strategy === "rate-limit" ? 1_000 : 500;
        const delayMs = exponentialDelay(this.attempts, base, strategy === "rate-limit" ? 0.15 : 0.1);
        return this.decision(strategy, reason, this.attempts, delayMs, true);
    }

    public getAttempt(trackId: string): number {
        return this.trackId === trackId ? this.attempts : 0;
    }

    private decision(strategy: RetryStrategy, reason: string, attempt: number, delayMs: number, refreshStream: boolean): RetryDecision {
        return { retry: true, attempt, delayMs, reason, strategy, refreshStream };
    }

    private noRetry(strategy: RetryStrategy, reason: string): RetryDecision {
        return { retry: false, attempt: this.attempts, delayMs: 0, reason, strategy, refreshStream: false };
    }
}

function exponentialDelay(attempt: number, baseMs: number, jitterFraction = 0): number {
    const delay = Math.min(8_000, baseMs * (2 ** (attempt - 1)));
    return Math.round(delay + delay * jitterFraction * Math.random());
}
