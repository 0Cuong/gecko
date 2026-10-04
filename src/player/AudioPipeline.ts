import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";

const require = createRequire(import.meta.url);
const bundledFfmpegPath = require("ffmpeg-static") as string | null;

/**
 * Resolves the optimal FFmpeg binary.
 * Prefers system FFmpeg (dynamically linked to host libc/OpenSSL) over static builds
 * to prevent TLS/GnuTLS SIGSEGV crashes on HTTPS direct streams in container runtimes.
 */
export function resolveFfmpegExecutable(): string {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

    // Check if system ffmpeg exists and functions properly
    try {
        const check = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true, timeout: 1500 });
        if (check.status === 0) {
            return "ffmpeg";
        }
    } catch {}

    // Fallback to bundled static binary if present
    if (bundledFfmpegPath && existsSync(bundledFfmpegPath)) {
        return bundledFfmpegPath;
    }

    return "ffmpeg";
}

const DEFAULT_STALL_TIMEOUT_MS = 20_000;

export interface FfmpegUrlInput { url: string; headers?: Record<string, string>; }
export interface AudioPipelineOptions {
    filterArgs?: readonly string[];
    inlineVolume?: boolean;
    onError?(error: Error): void;
    /** Releases the extractor process paired with a pipe input. */
    onCleanup?(): void;
    isOggOpus?: boolean;
    inputFormat?: string;
    stallTimeoutMs?: number;
}
export interface AudioPipelineMetrics { createdAt: number; ffmpegSpawnedAt: number; firstByteAt: number | null; closedAt: number | null; timeToFirstByteMs: number | null; }

/** Owns exactly one FFmpeg process and releases every input/output resource idempotently. */
export class AudioPipeline {
    public readonly resource: AudioResource;
    public readonly createdAt = Date.now();
    public readonly ffmpegSpawnedAt: number;
    public lastDataAt = this.createdAt;
    public firstByteAt: number | null = null;
    public closedAt: number | null = null;

    private readonly ffmpeg: ChildProcess;
    private readonly sourceStream?: Readable;
    private closed = false;
    private reported = false;
    private stderr = "";
    private watchdogTimer: NodeJS.Timeout | null = null;
    private killTimer: NodeJS.Timeout | null = null;

    private readonly onSourceError = (error: Error) => this.fail(error);
    private readonly onFfmpegError = (error: Error) => this.fail(error);
    private readonly onCleanupStreamError = (error: Error) => {
        if (process.env.MUSIC_DEBUG === "true") console.debug("[Music][DEBUG] stream closed during cleanup", error.message);
    };
    private readonly onOutputData = () => {
        this.firstByteAt ??= Date.now();
        this.lastDataAt = Date.now();
        this.armWatchdog();
    };
    private readonly onStderrData = (data: Buffer) => {
        if (this.stderr.length < 16_384) this.stderr += data.toString("utf8");
    };
    private readonly onFfmpegClose = (code: number | null, signal: NodeJS.Signals | null) => {
        this.clearKillTimer();
        if (!this.closed && (code !== 0 || this.firstByteAt === null)) {
            this.fail(new Error(`FFmpeg exited ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${this.stderr || "no audio output"}`));
        }
    };

    public constructor(input: Readable | FfmpegUrlInput, private readonly options: AudioPipelineOptions = {}) {
        const direct = !(input as Readable).pipe;
        if (!direct) {
            this.sourceStream = input as Readable;
            if ((this.sourceStream as any).destroyed || (this.sourceStream as any).readableEnded) {
                throw new Error("AudioPipeline received an already closed or destroyed stream.");
            }
        } else {
            const urlInput = input as FfmpegUrlInput;
            if (!urlInput?.url || typeof urlInput.url !== "string" || !urlInput.url.trim().startsWith("http")) {
                throw new Error("AudioPipeline received an invalid direct media URL.");
            }
        }
        const filters = options.filterArgs ?? [];
        const args = direct
            ? directArgs(input as FfmpegUrlInput, filters, Boolean(options.isOggOpus && !filters.length), options.inputFormat)
            : pipeArgs(filters, Boolean(options.isOggOpus && !filters.length), options.inputFormat);

        this.ffmpegSpawnedAt = Date.now();
        const executable = resolveFfmpegExecutable();
        this.ffmpeg = spawn(executable, args, { stdio: [direct ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
        if (!this.ffmpeg.stdout) throw new Error("FFmpeg did not expose stdout.");

        this.ffmpeg.once("error", this.onFfmpegError);
        this.ffmpeg.once("close", this.onFfmpegClose);
        this.ffmpeg.stdout.on("data", this.onOutputData);
        this.ffmpeg.stdout.once("error", this.onFfmpegError);
        this.ffmpeg.stderr?.on("data", this.onStderrData);
        this.ffmpeg.stderr?.once("error", this.onFfmpegError);

        if (this.sourceStream) {
            if (!this.ffmpeg.stdin) throw new Error("FFmpeg did not expose stdin.");
            this.sourceStream.once("error", this.onSourceError);
            this.ffmpeg.stdin.once("error", this.onFfmpegError);
            this.sourceStream.pipe(this.ffmpeg.stdin);
        }

        this.resource = createAudioResource(this.ffmpeg.stdout, {
            inputType: StreamType.OggOpus,
            inlineVolume: options.inlineVolume ?? true,
        });
        this.armWatchdog();
    }

    public get timeToFirstByteMs(): number | null { return this.firstByteAt === null ? null : this.firstByteAt - this.createdAt; }
    public get metrics(): AudioPipelineMetrics { return { createdAt: this.createdAt, ffmpegSpawnedAt: this.ffmpegSpawnedAt, firstByteAt: this.firstByteAt, closedAt: this.closedAt, timeToFirstByteMs: this.timeToFirstByteMs }; }

    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.closedAt = Date.now();
        this.clearWatchdog();

        this.sourceStream?.off("error", this.onSourceError);
        if (this.sourceStream && this.ffmpeg.stdin) {
            this.sourceStream.unpipe(this.ffmpeg.stdin);
            this.sourceStream.once("error", this.onCleanupStreamError);
            this.sourceStream.destroy();
        }
        this.ffmpeg.stdin?.off("error", this.onFfmpegError);
        this.ffmpeg.stdout?.off("data", this.onOutputData);
        this.ffmpeg.stdout?.off("error", this.onFfmpegError);
        this.ffmpeg.stderr?.off("data", this.onStderrData);
        this.ffmpeg.stderr?.off("error", this.onFfmpegError);

        try {
            this.options.onCleanup?.();
        } catch (error) {
            console.warn("[Music][WARN] extractor cleanup failed", error instanceof Error ? error.message : String(error));
        }

        for (const stream of [this.ffmpeg.stdin, this.ffmpeg.stdout, this.ffmpeg.stderr]) {
            stream?.once("error", this.onCleanupStreamError);
            stream?.destroy();
        }
        if (this.ffmpeg.exitCode === null) {
            try {
                this.ffmpeg.kill("SIGTERM");
            } catch (error) {
                console.warn("[Music][WARN] FFmpeg SIGTERM failed", error instanceof Error ? error.message : String(error));
            }
            this.killTimer = setTimeout(() => {
                if (this.ffmpeg.exitCode === null) {
                    try {
                        this.ffmpeg.kill("SIGKILL");
                    } catch (error) {
                        console.warn("[Music][WARN] FFmpeg SIGKILL failed", error instanceof Error ? error.message : String(error));
                    }
                }
            }, 2_000);
            this.killTimer.unref();
        }
    }

    private armWatchdog(): void {
        if (this.closed) return;
        this.clearWatchdog();
        const timeout = this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
        this.watchdogTimer = setTimeout(() => {
            this.watchdogTimer = null;
            if (!this.closed && Date.now() - this.lastDataAt >= timeout) {
                this.fail(new Error(`FFmpeg/audio stream stalled for ${timeout}ms`));
            }
        }, timeout);
        this.watchdogTimer.unref();
    }

    private clearWatchdog(): void {
        if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
    }

    private clearKillTimer(): void {
        if (this.killTimer) clearTimeout(this.killTimer);
        this.killTimer = null;
    }

    private fail(error: Error): void {
        if (this.closed || this.reported) return;
        this.reported = true;
        this.options.onError?.(error);
    }
}

function base(isDirect = false): string[] {
    const args = [
        "-hide_banner",
        "-loglevel", "warning",
        "-fflags", "+nobuffer+discardcorrupt",
        "-analyzeduration", "500000",
        "-probesize", "500000"
    ];
    if (isDirect) {
        args.push("-nostdin");
    }
    return args;
}

function output(filters: readonly string[], copy: boolean): string[] {
    return copy
        ? ["-c:a", "copy", "-page_duration", "20000", "-flush_packets", "1", "-f", "ogg", "pipe:1"]
        : [...filters, "-c:a", "libopus", "-application", "audio", "-frame_duration", "20", "-b:a", "128k", "-vbr", "constrained", "-compression_level", "3", "-ar", "48000", "-ac", "2", "-page_duration", "20000", "-flush_packets", "1", "-f", "ogg", "pipe:1"];
}

function directArgs(input: FfmpegUrlInput, filters: readonly string[], copy: boolean, format?: string): string[] {
    const args = [
        ...base(true),
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-rw_timeout", "15000000"
    ];
    if (input.headers && Object.keys(input.headers).length) {
        args.push("-headers", `${Object.entries(input.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n`);
    }
    if (format) args.push("-f", format);
    args.push("-i", input.url, "-vn", "-map", "0:a:0?");
    return [...args, ...output(filters, copy)];
}

function pipeArgs(filters: readonly string[], copy: boolean, format?: string): string[] {
    const args = base(false);
    if (format) args.push("-f", format);
    args.push("-i", "pipe:0", "-vn", "-map", "0:a:0?");
    return [...args, ...output(filters, copy)];
}
