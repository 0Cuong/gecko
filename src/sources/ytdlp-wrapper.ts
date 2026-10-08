import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
    accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync,
    renameSync, unlinkSync, createWriteStream
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import nodePath from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import got from "got";
import { LRUCache } from "../utils/cache.js";
import { Singleflight } from "./spotify.js";
import { SecurityManager } from "../utils/security.js";
import { downloadExecutable } from "../utils/ytdlp/index.js";

const suffix = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? "_macos" : "";
const filename = `yt-dlp${suffix}`;
const scriptsPath = nodePath.resolve(process.cwd(), "cache", "scripts");
const exePath = nodePath.resolve(scriptsPath, filename);

export const BROWSERS_FOR_COOKIES: readonly string[] = Object.freeze(["chrome", "brave", "firefox", "edge"]);
export let cachedWorkingBrowser: string | null = null;

export interface TikTokStrategy {
    browser?: string | null;
    profile?: string | null;
    impersonate?: string | null;
}

export interface AudioStreamResult {
    type: "direct" | "pipe";
    stream: Readable | null;
    process: ChildProcess | null;
    url?: string;
    headers?: Record<string, string>;
    ffmpegArgs?: string[];
    expiresAt?: number;
}

export interface ResolvedStreamCache {
    url: string;
    headers: Record<string, string>;
    ffmpegArgs: string[];
    expiresAt: number;
}

class TikTokStrat implements TikTokStrategy {
    constructor(
        public browser: string | null = null,
        public profile: string | null = null,
        public impersonate: string | null = null
    ) {}
}

const domainStrategyCache = new Map<string, TikTokStrategy>();
let updatePromise: Promise<void> | null = null;
const exeMode = process.platform === "win32" ? 0o666 : 0o755;
let isExecutableEnsured = false;

const DANGEROUS_CLI_FLAGS: ReadonlySet<string> = new Set([
    "exec", "exec-before-download", "config-location", "config-locations",
    "batch-file", "output", "paths", "cache-dir", "plugin-dirs", "o"
]);

const INTERNAL_OPTIONS: ReadonlySet<string> = new Set([
    "maxStdoutSize", "timeout", "stallTimeout", "retryCount", "debug", "cookies",
    "cookiesFromBrowser", "cookies-from-browser", "browserProfile",
    "browser-profile", "extractorArgs", "extractor-args", "impersonate",
    "userAgent", "user-agent", "addHeader", "add-header",
    "_isFallback", "_isRecovery", "_retryAttempt", "_ignoreCookies",
    "_ignoreImpersonate", "_usedBrowser", "_usedProfile", "_isUpdate",
    "source", "engine", "resolver", "provider", "platform", "youtube",
    "tiktok", "fallback", "browserName", "limit", "hd", "forcePipe", "forceNoCache"
]);

const OPTION_MAP: Readonly<Record<string, string>> = Object.freeze({
    noPlaylist: "no-playlist",
    yesPlaylist: "yes-playlist",
    flatPlaylist: "flat-playlist",
    dumpSingleJson: "dump-single-json",
    printJson: "print-json",
    dumpJson: "dump-json",
    noWarnings: "no-warnings",
    noCheckCertificate: "no-check-certificate",
    userAgent: "user-agent",
    addHeader: "add-header",
    extractorArgs: "extractor-args",
    cookiesFromBrowser: "cookies-from-browser",
    browserProfile: "browser-profile",
    socketTimeout: "socket-timeout",
    retrySleep: "retry-sleep",
    fragmentRetries: "fragment-retries",
    extractorRetries: "extractor-retries",
    bufferSize: "buffer-size",
    skipDownload: "skip-download",
    maxDownloads: "max-downloads",
    writeSubtitles: "write-subs",
    writeAutoSubtitles: "write-auto-subs",
    subLangs: "sub-langs",
    concurrentFragments: "concurrent-fragments",
    geoBypassCountry: "geo-bypass-country"
});

// Comprehensive Regex Error Classifiers
const REGEX_TIKTOK_ERR = /unexpected response from webpage request|unable to extract universal data|universal_data|universal data|rehydration|video not available|status code 0|status code 403|status code 429|challenge|captcha|failed to parse json|expecting value|login required/i;
const REGEX_BOT_CHECK = /sign in to confirm|confirm you['’]re not a bot|bot detection|n-sig|sabr|po_token|captcha|login required/i;
const REGEX_PIPE_ERR = /broken pipe|epipe|econnreset|connection reset by peer/i;
const REGEX_UPDATE = /confirm you are on the latest version|yt-dlp -u|yt-dlp -U/i;
const REGEX_RATE_LIMIT = /429|too many requests|rate limit/i;
const REGEX_FORBIDDEN = /403|forbidden/i;
const REGEX_LOGIN = /login required|sign in/i;
const REGEX_UNAVAILABLE = /private video|unavailable|geo-restricted|not found/i;
const REGEX_TIMEOUT = /timed out|timeout/i;
const REGEX_NETWORK = /network error/i;
const REGEX_BAD_ARGS = /error: (?:unrecognized argument|no such option|conflicting options)/i;
const REGEX_LIVE_ENDED = /this live event has ended|live stream recording is not available/i;

const TIKTOK_EXCLUDE = ["prime.tiktok.com", "byteoversea", "ibytedtos", "v16-webapp", "v19-webapp"];

export class YTDPLError extends Error {
    constructor(message: string, public code = "EXTRACT_FAILED", public rawError: Error | null = null) {
        super(message);
        this.name = "YTDPLError";
    }
}

export function sanitizeYtdlOutput(data: any): any {
    if (data === null || data === undefined) return null;
    if (Array.isArray(data)) {
        for (let i = data.length - 1; i >= 0; i--) {
            if (data[i] === null || data[i] === undefined) data.splice(i, 1);
            else sanitizeYtdlOutput(data[i]);
        }
        return data;
    }
    if (typeof data === "object") {
        if (Array.isArray(data.entries)) {
            for (let i = data.entries.length - 1; i >= 0; i--) {
                const item = data.entries[i];
                if (item === null || item === undefined || typeof item !== "object") {
                    data.entries.splice(i, 1);
                } else {
                    sanitizeYtdlOutput(item);
                }
            }
        }
        if (Array.isArray(data.formats)) {
            for (let i = data.formats.length - 1; i >= 0; i--) {
                const item = data.formats[i];
                if (item === null || item === undefined || typeof item !== "object") {
                    data.formats.splice(i, 1);
                }
            }
        }
        return data;
    }
    return data;
}

export function isTikTokUrl(url: string): boolean {
    if (!url || typeof url !== "string") return false;
    for (let i = 0; i < TIKTOK_EXCLUDE.length; i++) {
        if (url.includes(TIKTOK_EXCLUDE[i])) return false;
    }
    return url.includes("tiktok.com") || url.includes("vm.tiktok.com") || url.includes("vt.tiktok.com");
}

export function classifyError(err: any, stderr = "", url = ""): YTDPLError {
    const rawMsg = err?.message ? `${err.message} ${stderr}` : stderr;
    const isTikTok = isTikTokUrl(url) || rawMsg.includes("[tiktok]") || rawMsg.includes("tiktok");

    if (REGEX_PIPE_ERR.test(rawMsg)) return new YTDPLError("Stream consumer closed connection (EPIPE)", "STREAM_CONSUMER_CLOSED", err);
    if (REGEX_BAD_ARGS.test(rawMsg)) return new YTDPLError(rawMsg || "Invalid yt-dlp arguments", "BAD_ARGUMENTS", err);
    if (isTikTok && REGEX_TIKTOK_ERR.test(rawMsg)) return new YTDPLError(rawMsg || "TikTok anti-bot block", "TIKTOK_BLOCKED", err);
    if (REGEX_BOT_CHECK.test(rawMsg)) return new YTDPLError(rawMsg || "Bot verification triggered by host", "BOT_DETECTION", err);
    if (REGEX_UPDATE.test(rawMsg)) return new YTDPLError(rawMsg || "yt-dlp update required", "UPDATE_REQUIRED", err);
    if (REGEX_RATE_LIMIT.test(rawMsg)) return new YTDPLError(rawMsg || "Rate limit reached (HTTP 429)", "RATE_LIMIT", err);
    if (REGEX_FORBIDDEN.test(rawMsg)) return new YTDPLError(rawMsg || "Access forbidden (HTTP 403)", "FORBIDDEN", err);
    if (REGEX_LOGIN.test(rawMsg)) return new YTDPLError(rawMsg || "Login required", "LOGIN_REQUIRED", err);
    if (REGEX_LIVE_ENDED.test(rawMsg)) return new YTDPLError(rawMsg || "Live stream has ended", "LIVE_ENDED", err);
    if (REGEX_UNAVAILABLE.test(rawMsg)) return new YTDPLError(rawMsg || "Resource unavailable", "VIDEO_UNAVAILABLE", err);
    if (err?.code === "ETIMEDOUT" || REGEX_TIMEOUT.test(rawMsg)) return new YTDPLError(rawMsg || "Operation timed out", "TIMEOUT", err);
    
    if (['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(err?.code) || REGEX_NETWORK.test(rawMsg)) {
        return new YTDPLError(rawMsg || "Network error occurred", "NETWORK_ERROR", err);
    }
    return new YTDPLError(rawMsg || "Extraction failed", "EXTRACT_FAILED", err);
}

export function mergeExtractorArgs(userArgs: any, defaultStr = ""): string[] {
    const args: string[] = defaultStr ? [defaultStr] : [];
    if (!userArgs) return args;
    const list = Array.isArray(userArgs) ? userArgs : [String(userArgs)];
    for (let i = 0; i < list.length; i++) if (list[i]) args.push("--extractor-args", String(list[i]));
    return args;
}

function ensureExecutable(): void {
    if (isExecutableEnsured || process.platform === "win32") return;
    if (!existsSync(exePath)) return;
    try {
        accessSync(exePath, constants.X_OK);
        isExecutableEnsured = true;
    } catch {
        try { chmodSync(exePath, exeMode); isExecutableEnsured = true; } catch {}
    }
}

function resolveYtdlpCommand(): string {
    const explicitPath = process.env.YTDLP_PATH;
    if (explicitPath && typeof explicitPath === "string" && explicitPath.trim().length > 0) {
        return explicitPath.trim();
    }
    if (existsSync(exePath)) {
        ensureExecutable();
        return exePath;
    }
    return "yt-dlp";
}

export function safeKill(proc: any, reason?: string): void {
    if (!proc || proc._isExpectedKilled || proc.killed || proc.exitCode !== null) return;
    
    proc._isExpectedKilled = true;
    proc._killReason = reason || "manual";

    try {
        if (proc.stdout) {
            proc.stdout.removeAllListeners();
            proc.stdout.destroy();
        }
        if (proc.stderr) {
            proc.stderr.removeAllListeners();
            proc.stderr.destroy();
        }
        if (proc.stdin) {
            proc.stdin.removeAllListeners();
            proc.stdin.destroy();
        }
    } catch {}

    if (process.platform === "win32" && proc.pid) {
        execFile("taskkill", ["/F", "/T", "/PID", String(proc.pid)], () => {});
    }
    try { proc.kill("SIGKILL"); } catch {}
}

let cachedAutoCookie: string | null = null;
function getAutoCookiePath(): string | null {
    if (cachedAutoCookie !== null && existsSync(cachedAutoCookie)) return cachedAutoCookie;
    const paths = [nodePath.join(process.cwd(), "cookies.txt"), nodePath.join(process.cwd(), "cache", "cookies.txt")];
    for (let i = 0; i < paths.length; i++) {
        if (existsSync(paths[i])) {
            cachedAutoCookie = paths[i];
            return cachedAutoCookie;
        }
    }
    cachedAutoCookie = null;
    return null;
}

/**
 * FAST_STREAM_MODE Flags: Strips all unnecessary Python runtime initialization
 */
const FAST_GLOBAL_FLAGS = [
    "--ignore-config",
    "--no-warnings",
    "--js-runtimes", "node",
    "--socket-timeout", "8",
    "--retries", "1",
    "--extractor-retries", "1"
];

const RECOVERY_GLOBAL_FLAGS = [
    "--ignore-config",
    "--js-runtimes", "node",
    "--remote-components", "ejs",
    "--extractor-retries", "3",
    "--fragment-retries", "5",
    "--retries", "2",
    "--buffer-size", "16K",
    "--socket-timeout", "15",
    "--retry-sleep", "fragment:0.5",
    "--retry-sleep", "extractor:1",
    "--no-warnings"
];

function injectNetworkingAndCookies(args: string[], url: string, opts: Record<string, any>) {
    const isTikTok = isTikTokUrl(url);

    if (isTikTok && !opts._retryAttempt) {
        const cachedStrat = domainStrategyCache.get("tiktok");
        if (cachedStrat) {
            opts._usedBrowser = cachedStrat.browser;
            opts._usedProfile = cachedStrat.profile;
            if (cachedStrat.impersonate === null) opts._ignoreImpersonate = true;
            else if (cachedStrat.impersonate !== undefined) opts.impersonate = cachedStrat.impersonate;
        }
    }

    if (!opts._ignoreCookies) {
        const allowCookies = Boolean(opts.allowCookies ?? opts.allowBrowserCookies);
        const browserCookie = opts.cookiesFromBrowser || opts["cookies-from-browser"] || opts._usedBrowser;
        const profile = opts.browserProfile || opts["browser-profile"] || opts._usedProfile;
        
        if (browserCookie && allowCookies) {
            args.push("--cookies-from-browser", profile ? `${browserCookie}:${profile}` : String(browserCookie));
        } else if (opts.cookies) {
            args.push("--cookies", String(opts.cookies));
        } else {
            const autoCookie = getAutoCookiePath();
            if (autoCookie) args.push("--cookies", autoCookie);
        }
    }

    if (isTikTok) args.push("--extractor-args", "tiktok:api_hostname=api-h2.tiktok.com;prefer_webpage=false");

    // YouTube currently applies bot/SABR restrictions to several web clients.
    // The Android client is the preferred server-side playback client because it
    // avoids the web flow that is producing LOGIN_REQUIRED/BOT_DETECTION on Render.
    const hasExplicitExtractorArgs = Boolean(opts.extractorArgs || opts["extractor-args"]);
    const isYouTube = /(?:youtube\.com|youtu\.be)\//i.test(url);
    if (isYouTube && !hasExplicitExtractorArgs) {
        args.push("--extractor-args", "youtube:player_client=android");
    }

    if (opts.extractorArgs || opts["extractor-args"]) {
        const uArgs = mergeExtractorArgs(opts.extractorArgs || opts["extractor-args"]);
        for (let i = 0; i < uArgs.length; i++) args.push(uArgs[i]);
    }

    if (!opts._ignoreImpersonate) {
        const imp = opts.impersonate || (isTikTok ? "chrome-136" : null);
        if (imp) args.push("--impersonate", String(imp));
    }

    const ua = opts.userAgent || opts["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
    args.push("--user-agent", String(ua));

    let hasAccept = false, hasSec = false;
    const hdrs = opts.addHeader || opts["add-header"];
    if (hdrs) {
        const hArr = Array.isArray(hdrs) ? hdrs : [hdrs];
        for (let i = 0; i < hArr.length; i++) {
            const h = String(hArr[i]);
            args.push("--add-header", h);
            const lower = h.toLowerCase();
            if (lower.startsWith("accept-language:")) hasAccept = true;
            if (lower.startsWith("sec-ch-ua:")) hasSec = true;
        }
    }

    if (isTikTok) {
        if (!hasAccept) args.push("--add-header", "Accept-Language: en-US,en;q=0.9");
        if (!hasSec) args.push("--add-header", 'Sec-Ch-UA: "Chromium";v="136", "Google Chrome";v="136", "Not_A Brand";v="24"');
        if (!opts.geoBypassCountry && !opts["geo-bypass-country"] && !opts.geoBypass && !opts["geo-bypass"]) {
            args.push("--geo-bypass-country", "US");
        }
    }
}

export function buildArgs(url: string, opts: Record<string, any> = {}): string[] {
    const baseFlags = opts._isRecovery ? RECOVERY_GLOBAL_FLAGS : FAST_GLOBAL_FLAGS;
    const args: string[] = [...baseFlags];
    
    // Prefer native Opus format for fast demuxing
    args.push("--format", "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=m4a]/bestaudio/best");

    injectNetworkingAndCookies(args, url, opts);

    let playFlag = "--no-playlist";
    if (opts.yesPlaylist || opts["yes-playlist"]) playFlag = "--yes-playlist";
    else if (opts.flatPlaylist || opts["flat-playlist"]) playFlag = "--flat-playlist";
    args.push(playFlag);

    for (const key in opts) {
        if (key.charCodeAt(0) === 95 || INTERNAL_OPTIONS.has(key)) continue;
        const val = opts[key];
        if (val === undefined || val === null || val === "") continue;
        if (key.includes("Playlist") || key.includes("playlist")) continue;

        const kebabKey = OPTION_MAP[key] || key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        if (DANGEROUS_CLI_FLAGS.has(kebabKey)) continue;

        const flag = `--${kebabKey}`;
        if (val === true) args.push(flag);
        else if (Array.isArray(val)) {
            for (let k = 0; k < val.length; k++) if (val[k]) args.push(flag, String(val[k]));
        } else if (val !== false) {
            args.push(flag, String(val));
        }
    }

    if (url) args.push(url);
    return args;
}

export function buildStreamArgs(url: string, opts: Record<string, any> = {}): string[] {
    const baseFlags = opts._isRecovery ? RECOVERY_GLOBAL_FLAGS : FAST_GLOBAL_FLAGS;
    const args: string[] = [...baseFlags];
    
    args.push("--no-playlist");
    args.push("--format", "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=m4a]/bestaudio/best");
    args.push("--output", "-");

    injectNetworkingAndCookies(args, url, opts);

    const STREAM_SAFE_FLAGS = new Set(["addHeader", "add-header", "extractorArgs", "extractor-args"]);

    for (const key in opts) {
        if (key.charCodeAt(0) === 95 || INTERNAL_OPTIONS.has(key)) continue;
        
        const kebabKey = OPTION_MAP[key] || key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        
        if (kebabKey.includes("json") || kebabKey.includes("print") || kebabKey.includes("dump") || kebabKey.includes("simulate")) {
            continue;
        }

        if (DANGEROUS_CLI_FLAGS.has(kebabKey) || !STREAM_SAFE_FLAGS.has(kebabKey)) continue;

        const val = opts[key];
        const flag = `--${kebabKey}`;
        if (val === true) args.push(flag);
        else if (Array.isArray(val)) {
            for (let k = 0; k < val.length; k++) if (val[k]) args.push(flag, String(val[k]));
        } else if (val !== false) {
            args.push(flag, String(val));
        }
    }

    if (url) args.push(url);
    return args;
}

function json(str: string): any {
    if (typeof str !== "string") return str;
    let s = str.trim();
    if (!s) return s;
    if (s[0] !== "{" && s[0] !== "[") {
        const first = s.search(/[{[]/);
        const last = s.search(/[}\]][^}\]]*$/);
        if (first !== -1 && last > first) s = s.substring(first, last + 1);
    }
    try { return JSON.parse(s); } catch { return str; }
}

export const exec = (url: string, opts: Record<string, any> = {}, spawnOpts: Record<string, any> = {}) => {
    const cmd = resolveYtdlpCommand();
    return spawn(cmd, buildArgs(url, opts), { windowsHide: true, ...spawnOpts });
};

let lastBinaryUpdateMs = 0;
const BINARY_UPDATE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export async function updateYtdlBinary(force = false): Promise<void> {
    if (!force && Date.now() - lastBinaryUpdateMs < BINARY_UPDATE_COOLDOWN_MS) {
        return;
    }
    if (updatePromise) return updatePromise;

    lastBinaryUpdateMs = Date.now();
    updatePromise = (async () => {
        try {
            await downloadExecutable();
            isExecutableEnsured = true;
        } catch (err) {
            throw new YTDPLError("Update failed", "UPDATE_FAILED", err as Error);
        } finally {
            updatePromise = null;
        }
    })();

    return updatePromise;
}

export async function runYtdl(url: string, options: Record<string, any> = {}, spawnOptions: Record<string, any> = {}): Promise<any> {
    if (url && (url.startsWith("http://") || url.startsWith("https://") || url.includes("://"))) {
        await SecurityManager.assertPublicHttpUrl(url);
    }
    const maxStdoutSize = options.maxStdoutSize || 50 * 1024 * 1024;
    const processTimeout = options.timeout || 25_000;

    const proc = exec(url, options, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutLen = 0;
    let timeoutTimer: NodeJS.Timeout | null = null;

    return new Promise((resolve, reject) => {
        let isSettled = false;
        
        const cleanupAndReject = (err: any) => {
            if (isSettled) return;
            isSettled = true; 
            safeKill(proc, "metadata-timeout-or-limit"); 
            if (timeoutTimer) clearTimeout(timeoutTimer);
            reject(err);
        };

        if (proc.stderr) {
            proc.stderr.on("data", (chunk: Buffer) => {
                if (stderr.length < 10_485_760) stderr += stderrDecoder.write(chunk);
            });
        }

        if (proc.stdout) {
            proc.stdout.on("data", (chunk: Buffer) => {
                stdoutLen += chunk.length;
                if (stdoutLen > maxStdoutSize) {
                    cleanupAndReject(new YTDPLError("yt-dlp stdout limit exceeded", "EXTRACT_FAILED"));
                } else {
                    stdout += stdoutDecoder.write(chunk);
                }
            });
        }

        proc.on("error", (err: any) => {
            stderr += stderrDecoder.end();
            cleanupAndReject(classifyError(err, stderr.trim(), url));
        });

        proc.on("close", (code: number) => {
            if (isSettled) return;
            isSettled = true; 
            if (timeoutTimer) clearTimeout(timeoutTimer);
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
            
            if (code !== 0) {
                return reject(classifyError(new Error(stderr.trim() || `Exit ${code}`), stderr.trim(), url));
            }

            const parsed = json(stdout);
            const sanitized = sanitizeYtdlOutput(parsed);

            if (sanitized === null || sanitized === undefined) {
                return reject(new YTDPLError("yt-dlp returned empty or null metadata payload", "EXTRACT_FAILED"));
            }

            resolve(sanitized);
        });

        if (processTimeout > 0) {
            timeoutTimer = setTimeout(() => cleanupAndReject(new YTDPLError("Process timed out", "TIMEOUT")), processTimeout);
            if (timeoutTimer.unref) timeoutTimer.unref();
        }
    });
}

const RECOVERY_STEPS = [
    new TikTokStrat(null, null, "chrome-136"),
    new TikTokStrat(null, null, "firefox-135"),
    new TikTokStrat("chrome", null, "chrome-136"),
    new TikTokStrat("edge", null, "chrome-136"),
    new TikTokStrat("brave", null, "chrome-136"),
    new TikTokStrat("firefox", null, "firefox-135"),
    new TikTokStrat("file", null, "chrome-136")
];

async function runTikTokRecoveryPipeline(url: string, opts: Record<string, any>, spawnOpts: Record<string, any>): Promise<any> {
    let lastErr: any = null;
    let hasAttemptedUpdate = false;

    const runOpts = Object.assign({}, opts);
    delete runOpts.cookies;
    delete runOpts.cookiesFromBrowser;
    delete runOpts["cookies-from-browser"];

    const allowBrowserCookies = Boolean(opts.allowCookies ?? opts.allowBrowserCookies);

    for (let i = 0; i < RECOVERY_STEPS.length; i++) {
        const step = RECOVERY_STEPS[i];
        if (step.browser !== "file" && !allowBrowserCookies) continue;
        if (step.browser === "file" && !opts.cookies && !getAutoCookiePath()) continue;

        runOpts._retryAttempt = i + 1;
        runOpts._usedBrowser = step.browser === "file" ? null : step.browser;
        runOpts.cookiesFromBrowser = step.browser === "file" ? null : step.browser;
        runOpts.cookies = step.browser === "file" ? (opts.cookies || getAutoCookiePath()) : null;
        runOpts.impersonate = step.impersonate;
        runOpts._isRecovery = true;

        try {
            const res = await runYtdl(url, runOpts, spawnOpts);
            domainStrategyCache.set("tiktok", step);
            return res;
        } catch (err: any) {
            lastErr = err;
            if (err?.code === "UPDATE_REQUIRED" && !hasAttemptedUpdate) {
                hasAttemptedUpdate = true;
                try {
                    await updateYtdlBinary();
                    runOpts._isUpdate = true;
                    const res = await runYtdl(url, runOpts, spawnOpts);
                    domainStrategyCache.set("tiktok", step);
                    return res;
                } catch (updErr) { lastErr = updErr; }
            }
            if (err?.code === "RATE_LIMIT") {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw lastErr || new YTDPLError("TikTok download failed on all recovery attempts", "TIKTOK_BLOCKED");
}

const wrapperMetadataCache = new LRUCache<string, any>({ maxSize: 400, ttlMs: 15 * 60 * 1000 });
// Signed media URLs are transport credentials, not durable metadata. Keep only a small
// near-term cache for the prefetch hand-off and always invalidate it on playback errors.
const directStreamUrlCache = new LRUCache<string, ResolvedStreamCache>({ maxSize: 200, ttlMs: 2 * 60 * 1000 });
const wrapperSingleflight = new Singleflight<any>();

/** Raw yt-dlp payloads often include signed media URLs. They are stream data, not metadata. */
function cacheMetadataOnly(key: string, value: any): void {
    const containsStream = typeof value?.url === "string" ||
        (Array.isArray(value?.formats) && value.formats.some((format: any) => typeof format?.url === "string")) ||
        (Array.isArray(value?.requested_formats) && value.requested_formats.some((format: any) => typeof format?.url === "string"));
    if (!containsStream) wrapperMetadataCache.set(key, value);
}

export default async function ytdl(url: string, opts: Record<string, any> = {}, spawnOpts: Record<string, any> = {}): Promise<any> {
    if (isTikTokUrl(url)) return runTikTokRecoveryPipeline(url, opts, spawnOpts);

    const cacheKey = `${url}:${Boolean(opts.dumpSingleJson)}:${Boolean(opts.flatPlaylist)}`;
    if (!opts.forceNoCache) {
        const cached = wrapperMetadataCache.get(cacheKey);
        if (cached) return cached;
    }

    return wrapperSingleflight.do(cacheKey, 25_000, async () => {
        const maxRetries = opts.retryCount ?? 1;
        let lastError: any = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const currentOpts = attempt > 0 ? { ...opts, _isRecovery: true } : opts;
                const res = await runYtdl(url, currentOpts, spawnOpts);
                if (res) cacheMetadataOnly(cacheKey, res);
                return res;
            } catch (err: any) {
                lastError = err;
                if (err?.code === "UPDATE_REQUIRED") {
                    await updateYtdlBinary();
                    const res = await runYtdl(url, { ...opts, _isUpdate: true, _isRecovery: true }, spawnOpts);
                    if (res) cacheMetadataOnly(cacheKey, res);
                    return res;
                }
                if (attempt >= maxRetries) break;
                if (!["FORBIDDEN", "RATE_LIMIT", "LOGIN_REQUIRED", "EXTRACT_FAILED", "TIMEOUT", "NETWORK_ERROR"].includes(err.code)) break;

                const allowBrowserCookies = Boolean(opts.allowCookies ?? opts.allowBrowserCookies);
                if (attempt === 0 && !opts.cookies && !opts.cookiesFromBrowser && allowBrowserCookies) {
                    const browsers = cachedWorkingBrowser ? [cachedWorkingBrowser, ...BROWSERS_FOR_COOKIES.filter(b => b !== cachedWorkingBrowser)] : BROWSERS_FOR_COOKIES;
                    for (let i = 0; i < browsers.length; i++) {
                        try {
                            const res = await runYtdl(url, { ...opts, cookiesFromBrowser: browsers[i], timeout: 10_000, _isRecovery: true }, spawnOpts);
                            cachedWorkingBrowser = browsers[i];
                            if (res) cacheMetadataOnly(cacheKey, res);
                            return res;
                        } catch (browserErr: any) {
                            if (!browserErr.message.includes("could not find")) lastError = browserErr;
                        }
                    }
                }
            }
        }
        throw lastError;
    });
}

export function isUrlExpired(info: any, bufferSeconds = 60): boolean {
    const urlStr = typeof info === "string" ? info : info?.url;
    if (!urlStr) return true;
    const expireMatch = /[?&](expire|x-expires)=([0-9]+)/.exec(urlStr);
    if (expireMatch) {
        const expireUnix = parseInt(expireMatch[2], 10);
        return Math.floor(Date.now() / 1000) >= (expireUnix - bufferSeconds);
    }
    return false;
}

const FFMPEG_LOW_LATENCY_BASE_ARGS = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "2",
    "-fflags", "+nobuffer+fastseek+discardcorrupt",
    "-flags", "low_delay",
    "-analyzeduration", "100000",
    "-probesize", "32768"
];

export function extractDirectAudioStream(info: any): { url: string; headers: Record<string, string>; ffmpegArgs: string[]; expiresAt: number } | null {
    if (!info) return null;
    let mediaUrl = info.url;
    let fmt = info;

    if (!mediaUrl && info.formats?.length > 0) {
        let bestFormat = null;
        for (let i = 0; i < info.formats.length; i++) {
            const f = info.formats[i];
            if (f.url && f.acodec && f.acodec !== "none") {
                if (f.acodec.includes("opus")) {
                    bestFormat = f;
                    break;
                }
                if (!bestFormat || (f.tbr || f.abr || 0) > (bestFormat.tbr || bestFormat.abr || 0)) {
                    bestFormat = f;
                }
            }
        }
        fmt = bestFormat || info.formats.find((f: any) => f.url) || info.formats[0];
        mediaUrl = fmt?.url;
    }
    if (!mediaUrl || isUrlExpired(mediaUrl)) return null;

    const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        ...(info.http_headers || {}), ...(fmt?.http_headers || {})
    };

    const cookie = fmt?.cookies || info.cookies;
    if (cookie && !headers["Cookie"] && !headers["cookie"]) headers["Cookie"] = cookie;

    const args = FFMPEG_LOW_LATENCY_BASE_ARGS.slice();
    let headerLines = "";
    for (const k in headers) headerLines += `${k}: ${headers[k]}\r\n`;
    if (headerLines) args.push("-headers", headerLines + "\r\n");
    args.push("-i", mediaUrl);

    // An expiry that cannot be read must never become a long-lived CDN cache entry.
    // Five minutes is only a conservative transport cache; known signed URLs use their real expiry.
    let expiresAt = Math.floor(Date.now() / 1000) + 300;
    const expireMatch = /[?&](expire|x-expires)=([0-9]+)/.exec(mediaUrl);
    if (expireMatch) {
        expiresAt = parseInt(expireMatch[2], 10);
    }

    return { url: mediaUrl, headers, ffmpegArgs: args, expiresAt };
}

export function getFFmpegArgs(info: any): string[] {
    if (typeof info === "string") {
        return [...FFMPEG_LOW_LATENCY_BASE_ARGS, "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", "-i", info];
    }
    return extractDirectAudioStream(info)?.ffmpegArgs || [];
}

export function invalidateStreamCache(url: string): void {
    directStreamUrlCache.delete(url);
    wrapperMetadataCache.delete(`${url}:true:false`);
    wrapperMetadataCache.delete(`${url}:false:false`);
}

/**
 * FAST_STREAM_MODE: Direct URL Extraction Engine (ZERO Subprocess Duplication)
 */
export async function createAudioStream(
    url: string,
    options: Record<string, any> = {}
): Promise<AudioStreamResult> {
    if (url && (url.startsWith("http://") || url.startsWith("https://") || url.includes("://"))) {
        await SecurityManager.assertPublicHttpUrl(url);
    }
    // 1. DIRECT STREAM CACHE LOOKUP (0ms Latency)
    if (!options.forceNoCache) {
        const cachedStream = directStreamUrlCache.get(url);
        if (cachedStream && cachedStream.expiresAt > Math.floor(Date.now() / 1000) + 60) {
            return {
                type: "direct",
                stream: null,
                process: null,
                url: cachedStream.url,
                headers: cachedStream.headers,
                ffmpegArgs: cachedStream.ffmpegArgs,
                expiresAt: cachedStream.expiresAt * 1000,
            };
        }
    }

    // 2. FORCE PIPE DIRECTLY IF REQUESTED (TikTok or forced pipe with stream validation)
    if (options.forcePipe) {
        const streamArgs = buildStreamArgs(url, options);
        const proc = execStreamProcess(url, streamArgs, options);
        const validated = await validateStreamProcess(proc, url);
        return {
            type: "pipe",
            stream: validated.stream,
            process: proc,
        };
    }

    // 3. SINGLE-PASS METADATA & DIRECT URL RESOLUTION
    let extractionError: YTDPLError | null = null;
    try {
        const info = await ytdl(url, { ...options, dumpSingleJson: true });
        const direct = extractDirectAudioStream(info);

        if (direct && direct.url) {
            const cacheTtlMs = Math.max(1_000, Math.min(120_000, direct.expiresAt * 1000 - Date.now() - 60_000));
            directStreamUrlCache.set(url, {
                url: direct.url,
                headers: direct.headers,
                ffmpegArgs: direct.ffmpegArgs,
                expiresAt: direct.expiresAt
            }, cacheTtlMs);

            return {
                type: "direct",
                stream: null,
                process: null,
                url: direct.url,
                headers: direct.headers,
                ffmpegArgs: direct.ffmpegArgs,
                expiresAt: direct.expiresAt * 1000,
            };
        }
    } catch (err: any) {
        invalidateStreamCache(url);
        extractionError = err instanceof YTDPLError ? err : classifyError(err, "", url);

        // If this is a bot detection or fatal/non-retryable error, DO NOT blindly fall back to pipe streaming
        // because running the same URL through yt-dlp pipe will fail for the exact same reason!
        if (["BOT_DETECTION", "VIDEO_UNAVAILABLE", "LOGIN_REQUIRED", "NON_RETRYABLE", "TIKTOK_BLOCKED", "LIVE_ENDED"].includes(extractionError.code)) {
            // Attempt fallback player client if it's YouTube bot detection
            if (extractionError.code === "BOT_DETECTION" && url.includes("youtube.com") && !options._triedFallback) {
                try {
                    const fallbackArgs = "youtube:player_client=mweb,tv;player_skip=configs";
                    const fallbackInfo = await ytdl(url, { ...options, dumpSingleJson: true, extractorArgs: fallbackArgs, _triedFallback: true });
                    const direct = extractDirectAudioStream(fallbackInfo);
                    if (direct && direct.url) {
                        return {
                            type: "direct",
                            stream: null,
                            process: null,
                            url: direct.url,
                            headers: direct.headers,
                            ffmpegArgs: direct.ffmpegArgs,
                            expiresAt: direct.expiresAt * 1000,
                        };
                    }
                } catch (fallbackErr: any) {
                    extractionError = fallbackErr instanceof YTDPLError ? fallbackErr : classifyError(fallbackErr, "", url);
                }
            }
            throw extractionError;
        }
    }

    // 4. FALLBACK TO STDOUT PIPE ONLY ON DIRECT EXTRACTION FORMAT FAILURE (Validated)
    const streamArgs = buildStreamArgs(url, { ...options, _isRecovery: true });
    const proc = execStreamProcess(url, streamArgs, options);
    try {
        const validated = await validateStreamProcess(proc, url);
        return {
            type: "pipe",
            stream: validated.stream,
            process: proc,
        };
    } catch (streamErr) {
        throw extractionError || streamErr;
    }
}

export function validateStreamProcess(
    proc: ChildProcess,
    url: string,
    timeoutMs = 10_000
): Promise<{ stream: Readable; process: ChildProcess }> {
    return new Promise((resolve, reject) => {
        if (!proc.stdout) {
            safeKill(proc, "no-stdout");
            return reject(new YTDPLError("Extractor process did not expose stdout", "EXTRACT_FAILED"));
        }

        let settled = false;
        let timer: NodeJS.Timeout | null = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            proc.stdout?.removeListener("data", onFirstData);
            proc.removeListener("exit", onEarlyExit);
            proc.removeListener("error", onEarlyError);
        };

        const onFirstData = (chunk: Buffer) => {
            if (settled) return;
            settled = true;
            cleanup();
            // Put the initial chunk back into the stream buffer so FFmpeg receives the complete stream
            proc.stdout!.unshift(chunk);
            resolve({ stream: proc.stdout!, process: proc });
        };

        const onEarlyExit = (code: number | null, signal: string | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            const stderr = (proc as any)._capturedStderr || "";
            const err = new Error(stderr.trim() || `Extractor process exited prematurely with code ${code} / signal ${signal}`);
            const classified = classifyError(err, stderr, url);
            safeKill(proc, "early-exit");
            reject(classified);
        };

        const onEarlyError = (err: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            const stderr = (proc as any)._capturedStderr || "";
            const classified = classifyError(err, stderr, url);
            safeKill(proc, "early-error");
            reject(classified);
        };

        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            safeKill(proc, "startup-timeout");
            reject(new YTDPLError(`Audio stream extraction timed out after ${timeoutMs}ms`, "TIMEOUT"));
        }, timeoutMs);
        timer.unref();

        proc.stdout.once("data", onFirstData);
        proc.once("exit", onEarlyExit);
        proc.once("error", onEarlyError);
    });
}

export async function preloadTrackStream(url: string, options: Record<string, any> = {}): Promise<void> {
    if (!url || url.includes("spotify.com") || url.startsWith("spotify:") || isUrlExpired(url) || directStreamUrlCache.has(url)) return;
    try {
        await createAudioStream(url, { ...options, forceNoCache: false });
    } catch (error) {
        if (process.env.MUSIC_DEBUG === "true") {
            console.debug("[Music][DEBUG] stream prefetch failed", error instanceof Error ? error.message : String(error));
        }
    }
}

export function execStreamProcess(
    url: string,
    args: string[],
    options: Record<string, any> = {}
): ChildProcess {
    const cmd = resolveYtdlpCommand();
    const startTime = Date.now();
    const isDebug = options.debug || process.env.DEBUG === "true";

    const proc = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let isSettled = false;
    let bytesWritten = 0;

    if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => { bytesWritten += chunk.length; });
        proc.stdout.on("error", (err: any) => {
            if (err.code === "EPIPE" || err.code === "ECONNRESET") {
                if (!isSettled) {
                    isSettled = true;
                    (proc as any)._consumerClosed = true;
                    safeKill(proc, "stream-consumer-epipe");
                }
            }
        });
    }

    if (proc.stderr) {
        let stderrText = "";
        const stderrDecoder = new StringDecoder("utf8");

        proc.stderr.on("data", (chunk: Buffer) => {
            if (stderrText.length < 262_144) {
                stderrText += stderrDecoder.write(chunk);
            }
            (proc as any)._capturedStderr = stderrText;
        });

        // `close` is emitted after stdout has closed, which is too late to turn a
        // failed extractor into a stream error. Propagate at `exit` so FFmpeg and
        // the controller receive a recoverable failure instead of a false EOF.
        proc.once("exit", (code: number | null, signal: string | null) => {
            (proc as any)._capturedStderr = stderrText;
            if (isSettled || (proc as any)._consumerClosed || (proc as any)._isExpectedKilled || code === 0 || code === null) return;
            const classified = classifyError(new Error(stderrText.trim() || `Exit ${code} / Signal ${signal}`), stderrText, url);
            if (classified.code !== "STREAM_CONSUMER_CLOSED" && proc.stdout && !proc.stdout.destroyed) {
                proc.stdout.destroy(classified);
            }
        });

        proc.on("close", (code: number, signal: string | null) => {
            if (isSettled) return;
            isSettled = true;
            stderrText += stderrDecoder.end();
            (proc as any)._capturedStderr = stderrText;
            const lifetime = Date.now() - startTime;

            if ((proc as any)._consumerClosed || (proc as any)._isExpectedKilled) {
                return;
            }

            if (code !== 0 && code !== null) {
                const classified = classifyError(new Error(stderrText.trim() || `Exit ${code} / Signal ${signal}`), stderrText, url);
                
                if (classified.code === "STREAM_CONSUMER_CLOSED") return;

                // Forward extractor failure into the Readable so the playback
                // controller can classify/retry it rather than treating EOF as a
                // natural track end.
                if (proc.stdout && !proc.stdout.destroyed) {
                    proc.stdout.destroy(classified);
                }

                // ONLY update binary if yt-dlp explicitly requested UPDATE_REQUIRED.
                // NEVER update on BOT_DETECTION.
                if (classified.code === "UPDATE_REQUIRED") {
                    void updateYtdlBinary().catch((error: unknown) => {
                        console.warn("[Music][WARN] yt-dlp update after stream crash failed", error instanceof Error ? error.message : String(error));
                    });
                }

                console.error(`[yt-dlp Stream Crash] Code: ${code} | Type: ${classified.code} | Lifetime: ${lifetime}ms`);
            }
        });
        
        proc.on("error", (err) => {
            isSettled = true;
            if (proc.stdout && !proc.stdout.destroyed) proc.stdout.destroy(classifyError(err, stderrText, url));
            safeKill(proc, "spawn-error");
        });
    }

    return proc;
}
