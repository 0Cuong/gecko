import { spawn, execFile } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import got from "got";

const execFileAsync = promisify(execFile);
const suffix = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? "_macos" : "";
const filename = `yt-dlp${suffix}`;
const scriptsPath = nodePath.resolve(process.cwd(), "cache", "scripts");
const exePath = nodePath.resolve(scriptsPath, filename);
const exeMode = process.platform === "win32" ? 0o666 : 0o755;

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Edge/124.0.0.0"
];

const BROWSERS = ["chrome", "firefox", "edge"];

const INTERNAL_OPTIONS = new Set([
    "maxStdoutSize",
    "maxStderrSize",
    "timeout",
    "retryCount",
    "signal",
    "_isFallback",
    "_isRecovery",
    "_retryAttempt",
    "_ignoreCookies",
    "_ignoreImpersonate",
    "_ignoreUserAgent",
    "_usedBrowser"
]);

const TIKTOK_SHORT_LINK_REGEX = /https?:\/\/(?:(?:vm|vt|t)\.tiktok\.com\/[A-Za-z0-9_-]+|(?:www\.)?tiktok\.com\/t\/[A-Za-z0-9_-]+)/i;
const TIKTOK_GENERAL_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?tiktok\.com\//i;

let isExecutableEnsured = false;
let isBinaryVerified = false;
let binaryInitPromise = null;
let downloadPromise = null;
let cachedVersion = null;
let autoUpdateTimer = null;

const tikTokUrlCache = new Map();
const pendingExpansions = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

export class YTDPLError extends Error {
    constructor(message, code = "EXTRACT_FAILED", rawError = null) {
        super(message);
        this.name = "YTDPLError";
        this.code = code;
        this.rawError = rawError;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, YTDPLError);
        }
    }
}

export function isNonRetryableError(msg) {
    if (!msg || typeof msg !== "string") return false;
    const m = msg.toLowerCase();
    return (
        m.includes("video unavailable") ||
        m.includes("video has been deleted") ||
        m.includes("this video is private") ||
        m.includes("private video") ||
        m.includes("user has made this video private") ||
        m.includes("post has been removed") ||
        m.includes("is not a valid url") ||
        m.includes("404 not found") ||
        m.includes("http error 404") ||
        m.includes("this video is no longer available") ||
        m.includes("account has been terminated") ||
        m.includes("copyright claim") ||
        m.includes("geo-blocked") ||
        m.includes("not available in your country") ||
        m.includes("unsupported protocol")
    );
}

export function isBotDetectionError(msg) {
    const m = (msg ?? "").toLowerCase();
    return (
        m.includes("sign in to confirm you're not a bot") ||
        m.includes("sign in to confirm") ||
        m.includes("please sign in") ||
        m.includes("http error 429") ||
        m.includes("error 429") ||
        m.includes("too many requests") ||
        m.includes("login required")
    );
}

export function isUnavailableMediaError(msg) {
    const m = (msg ?? "").toLowerCase();
    return (
        m.includes("unable to extract universal data for rehydration") ||
        m.includes("unable to extract webpage") ||
        m.includes("something went wrong") ||
        m.includes("this post may not be comfortable for some audiences") ||
        m.includes("sign in required") ||
        m.includes("log in for access") ||
        m.includes("forbidden") ||
        m.includes("temporarily unavailable")
    );
}

export function isAgeRestrictedError(msg) {
    const m = (msg ?? "").toLowerCase();
    return (
        m.includes("age restricted content") ||
        (m.includes("age-restricted") && (m.includes("sign in") || m.includes("confirm")))
    );
}

export function isTikTokRestrictionError(msg) {
    const m = (msg ?? "").toLowerCase();
    return (
        m.includes("unable to extract webpage") ||
        m.includes("something went wrong") ||
        m.includes("sign in required") ||
        m.includes("http error 403") ||
        m.includes("forbidden") ||
        m.includes("429") ||
        m.includes("too many requests")
    );
}

export function getTikTokErrorMessage(msg) {
    const m = (msg ?? "").toLowerCase();
    if (m.includes("unable to extract webpage")) return "TikTok Extractor Error: 'Unable to extract webpage video data'. TikTok changed its layout or API signature.";
    if (m.includes("something went wrong")) return "TikTok Block: 'TikTok said something went wrong'. Fingerprint was flagged.";
    if (m.includes("sign in required") || m.includes("login required")) return "TikTok Auth Restriction: 'Sign in required' to access this content.";
    if (m.includes("403")) return "TikTok Blocked: HTTP 403 Forbidden. Your host IP may be blacklisted.";
    if (m.includes("429") || m.includes("too many requests")) return "TikTok Rate Limit: HTTP 429 Too Many Requests.";
    return "TikTok extraction failed due to platform restrictions.";
}

export function classifyError(err, stderr = "") {
    const msg = `${err?.message || ""} ${stderr || ""}`.toLowerCase();

    if (isNonRetryableError(msg)) {
        return new YTDPLError(stderr || err?.message || "Content unavailable or invalid URL", "NON_RETRYABLE", err);
    }
    if (msg.includes("unexpected response from webpage request") || msg.includes("confirm you're not a bot") || msg.includes("captcha") || isBotDetectionError(msg)) {
        return new YTDPLError(stderr || err?.message || "TikTok anti-bot challenge encountered", "TIKTOK_ANTIBOT", err);
    }
    if (msg.includes("unable to extract webpage") || msg.includes("unable to extract universal data") || msg.includes("something went wrong")) {
        return new YTDPLError(stderr || err?.message || "TikTok webpage extraction failed (layout or schema updated)", "TIKTOK_LAYOUT_CHANGED", err);
    }
    if (msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit")) {
        return new YTDPLError(stderr || err?.message || "Rate limit reached (HTTP 429)", "RATE_LIMIT", err);
    }
    if (msg.includes("403") || msg.includes("forbidden")) {
        return new YTDPLError(stderr || err?.message || "Access forbidden (HTTP 403)", "FORBIDDEN", err);
    }
    if (msg.includes("login required") || msg.includes("sign in required") || msg.includes("please sign in")) {
        return new YTDPLError(stderr || err?.message || "Authentication required", "LOGIN_REQUIRED", err);
    }
    if (err?.code === "ETIMEDOUT" || msg.includes("timed out") || msg.includes("timeout")) {
        return new YTDPLError(stderr || err?.message || "Operation timed out", "TIMEOUT", err);
    }
    if (["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"].includes(err?.code) || msg.includes("network error")) {
        return new YTDPLError(stderr || err?.message || "Network error occurred", "NETWORK_ERROR", err);
    }

    return new YTDPLError(stderr || err?.message || "Extraction failed", "EXTRACT_FAILED", err);
}

export function isTikTokUrl(url) {
    return typeof url === "string" && TIKTOK_GENERAL_REGEX.test(url);
}

export function isTikTokShortUrl(url) {
    return typeof url === "string" && TIKTOK_SHORT_LINK_REGEX.test(url);
}

export async function expandTikTokUrl(url, userAgent = USER_AGENTS[0]) {
    if (!url || typeof url !== "string" || !isTikTokShortUrl(url)) {
        return url;
    }

    const cached = tikTokUrlCache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.resolvedUrl;
    }

    if (pendingExpansions.has(url)) {
        return pendingExpansions.get(url);
    }

    const expansionPromise = (async () => {
        try {
            const resolvedUrl = await new Promise((resolve) => {
                let settled = false;
                const reqStream = got.stream(url, {
                    method: "GET",
                    followRedirect: true,
                    maxRedirects: 5,
                    timeout: { request: 5000 },
                    headers: {
                        "user-agent": userAgent,
                        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "accept-language": "en-US,en;q=0.9",
                    }
                });

                const cleanup = () => {
                    if (reqStream && !reqStream.destroyed) {
                        reqStream.destroy();
                    }
                };

                reqStream.on("response", (res) => {
                    if (settled) return;
                    settled = true;
                    const finalUrl = res.url || url;
                    cleanup();
                    resolve(finalUrl);
                });

                reqStream.on("error", (err) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    const fallbackUrl = err.response?.url || url;
                    resolve(fallbackUrl);
                });
            });

            if (tikTokUrlCache.size >= MAX_CACHE_SIZE) {
                const firstKey = tikTokUrlCache.keys().next().value;
                if (firstKey) tikTokUrlCache.delete(firstKey);
            }

            tikTokUrlCache.set(url, { resolvedUrl, timestamp: Date.now() });
            return resolvedUrl;
        } catch {
            return url;
        } finally {
            pendingExpansions.delete(url);
        }
    })();

    pendingExpansions.set(url, expansionPromise);
    return expansionPromise;
}

export function getTikTokExtractorArgs() {
    return {
        "extractor-args": "tiktok:app_version=33.0.0;manifest_app_version=33.0.0",
        "impersonate": "chrome",
        "referer": "https://www.tiktok.com/",
        "add-header": [
            "Accept-Language:en-US,en;q=0.9",
            "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Sec-Fetch-Mode:navigate",
            "Sec-Fetch-Dest:document",
            "Sec-Fetch-Site:cross-site"
        ],
        "extractor-retries": 5,
        "socket-timeout": 20
    };
}

export function resolveCookieOption(customPath) {
    const possiblePaths = [
        customPath,
        nodePath.resolve(process.cwd(), "cookies.txt"),
        nodePath.resolve(process.cwd(), "cache", "cookies.txt")
    ].filter(Boolean);

    for (const filePath of possiblePaths) {
        if (typeof filePath === "string" && existsSync(filePath)) {
            try {
                const stat = statSync(filePath);
                if (stat.isFile() && stat.size > 0) {
                    return { type: "file", flag: "cookies", value: filePath };
                }
            } catch {}
        }
    }

    return null;
}

export function getFallbackBrowserCookies(attemptIndex) {
    if (attemptIndex < 0 || attemptIndex >= BROWSERS.length) {
        return null;
    }
    const browser = BROWSERS[attemptIndex];
    return { type: "browser", flag: "cookiesFromBrowser", value: browser };
}

export function cleanupOldBackups(options = {}) {
    const {
        maxKeepOld = 0,
        excludePaths = [],
        minTmpAgeMs = 0
    } = options;

    if (!existsSync(scriptsPath)) {
        return 0;
    }

    let files = [];
    try {
        files = readdirSync(scriptsPath);
    } catch (err) {
        console.warn(`[yt-dlp] Cleanup warning: Failed to read scripts directory: ${err?.message || err}`);
        return 0;
    }

    const excludeSet = new Set((excludePaths || []).map(p => nodePath.resolve(p)));
    const now = Date.now();

    const oldFiles = [];
    const tmpFiles = [];

    for (const file of files) {
        const fullPath = nodePath.resolve(scriptsPath, file);

        if (fullPath === exePath || excludeSet.has(fullPath)) {
            continue;
        }

        const isOld = file.startsWith(`${filename}.old.`) || /^yt-dlp.*\.old\./i.test(file);
        const isTmp = file.startsWith(`${filename}.tmp.`) || /^yt-dlp.*\.tmp\./i.test(file);

        if (!isOld && !isTmp) {
            continue;
        }

        try {
            if (!existsSync(fullPath)) continue;
            const stat = statSync(fullPath);
            if (!stat.isFile()) continue;

            if (isOld) {
                oldFiles.push({ path: fullPath, file, mtimeMs: stat.mtimeMs });
            } else if (isTmp) {
                if (minTmpAgeMs > 0 && (now - stat.mtimeMs < minTmpAgeMs)) {
                    continue;
                }
                tmpFiles.push({ path: fullPath, file, mtimeMs: stat.mtimeMs });
            }
        } catch {
            continue;
        }
    }

    oldFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const oldFilesToDelete = oldFiles.slice(Math.max(0, maxKeepOld));
    const filesToDelete = [...tmpFiles, ...oldFilesToDelete];

    if (filesToDelete.length === 0) {
        return 0;
    }

    let deletedCount = 0;

    for (const item of filesToDelete) {
        try {
            if (existsSync(item.path)) {
                unlinkSync(item.path);
                deletedCount++;
            }
        } catch (err) {
            console.warn(`[yt-dlp] Cleanup warning: Failed to delete ${item.file}: ${err?.message || err}`);
        }
    }

    if (deletedCount > 0) {
        console.info(`[yt-dlp] Cleaned up ${deletedCount} unused temp/backup file(s) in cache/scripts.`);
    }

    return deletedCount;
}

export function ensureExecutable(targetPath = exePath) {
    if (isExecutableEnsured && targetPath === exePath) return;
    if (process.platform === "win32" || !existsSync(targetPath)) return;
    try {
        accessSync(targetPath, constants.X_OK);
        if (targetPath === exePath) isExecutableEnsured = true;
    } catch {
        try {
            chmodSync(targetPath, exeMode);
            if (targetPath === exePath) isExecutableEnsured = true;
        } catch (error) {
            console.warn(`[yt-dlp] Failed to set executable bit: ${error?.message || error}`);
        }
    }
}

export async function validateExecutable(targetPath) {
    try {
        const { stdout } = await execFileAsync(targetPath, ["--version"], { timeout: 5000 });
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

export async function getBinaryVersion(targetPath = exePath) {
    if (targetPath === exePath && cachedVersion) return cachedVersion;
    try {
        const { stdout } = await execFileAsync(targetPath, ["--version"], { timeout: 5000 });
        const ver = stdout.trim();
        if (targetPath === exePath) cachedVersion = ver;
        return ver;
    } catch {
        return "unknown";
    }
}

export async function downloadExecutable() {
    if (downloadPromise) return downloadPromise;

    downloadPromise = (async () => {
        const isUpdate = existsSync(exePath);
        console.info(`[yt-dlp] ${isUpdate ? "Updating" : "Downloading"} binary (Nightly Build)...`);

        cleanupOldBackups({ maxKeepOld: 1, minTmpAgeMs: 30_000 });

        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const tempPath = `${exePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
            let createdOldPath = null;
            try {
                const response = await got.get(`https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/${filename}`, {
                    timeout: { request: 60_000 },
                    responseType: "buffer"
                });

                mkdirSync(scriptsPath, { recursive: true });
                writeFileSync(tempPath, response.body, { mode: exeMode });

                if (process.platform !== "win32") {
                    try { chmodSync(tempPath, exeMode); } catch {}
                }

                const isValid = await validateExecutable(tempPath);
                if (!isValid) {
                    throw new Error("Downloaded yt-dlp binary failed validation check.");
                }

                if (existsSync(exePath)) {
                    if (process.platform === "win32") {
                        const oldPath = `${exePath}.old.${Date.now()}`;
                        try {
                            renameSync(exePath, oldPath);
                            createdOldPath = oldPath;
                        } catch {
                            try { unlinkSync(exePath); } catch {}
                        }
                    } else {
                        try { unlinkSync(exePath); } catch {}
                    }
                }

                try {
                    renameSync(tempPath, exePath);
                } catch (renameErr) {
                    try {
                        copyFileSync(tempPath, exePath);
                        try { unlinkSync(tempPath); } catch {}
                    } catch (copyErr) {
                        if (createdOldPath && existsSync(createdOldPath) && !existsSync(exePath)) {
                            try { renameSync(createdOldPath, exePath); } catch {}
                        }
                        throw copyErr;
                    }
                }

                cachedVersion = null;
                isExecutableEnsured = false;
                isBinaryVerified = true;
                ensureExecutable(exePath);

                cleanupOldBackups({ maxKeepOld: 0 });

                console.info(`[yt-dlp] ${isUpdate ? "Updated" : "Downloaded"} binary successfully.`);
                return;
            } catch (err) {
                lastErr = err;
                try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}

                if (createdOldPath && existsSync(createdOldPath) && !existsSync(exePath)) {
                    try { renameSync(createdOldPath, exePath); } catch {}
                }

                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
                }
            }
        }

        if (isUpdate) {
            console.warn(`[yt-dlp] Update failed, keeping existing binary: ${lastErr?.message || lastErr}`);
            ensureExecutable(exePath);
            cleanupOldBackups({ maxKeepOld: 1 });
        } else {
            cleanupOldBackups({ maxKeepOld: 0 });
            throw lastErr || new Error("Failed to download yt-dlp binary");
        }
    })();

    try {
        await downloadPromise;
    } finally {
        downloadPromise = null;
    }
}

export async function verifyAndEnsureBinary() {
    if (isBinaryVerified && existsSync(exePath)) {
        return;
    }

    if (binaryInitPromise) {
        return binaryInitPromise;
    }

    binaryInitPromise = (async () => {
        cleanupOldBackups({ maxKeepOld: 1 });

        if (!existsSync(exePath)) {
            await downloadExecutable();
            return;
        }

        ensureExecutable(exePath);
        const version = await getBinaryVersion();
        if (version === "unknown") {
            console.warn("[yt-dlp] Executable corrupted or unusable. Re-downloading...");
            await downloadExecutable();
        } else {
            isBinaryVerified = true;
        }
    })();

    try {
        await binaryInitPromise;
    } finally {
        binaryInitPromise = null;
    }
}

export function startAutoUpdater() {
    if (autoUpdateTimer) return;
    autoUpdateTimer = setInterval(async () => {
        try {
            if (!existsSync(exePath)) return;
            const stat = statSync(exePath);
            if (Date.now() - stat.mtimeMs < 2 * 60 * 60 * 1000) return;
            await downloadExecutable();
        } catch (err) {
            console.warn(`[yt-dlp] Background update check failed: ${err?.message || err}`);
        }
    }, 30 * 60 * 1000);

    if (autoUpdateTimer.unref) {
        autoUpdateTimer.unref();
    }
}

export function stopAutoUpdater() {
    if (autoUpdateTimer) {
        clearInterval(autoUpdateTimer);
        autoUpdateTimer = null;
    }
}

export function safeKill(proc) {
    if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) {
        return;
    }
    try {
        proc.kill("SIGTERM");
    } catch {}

    const timer = setTimeout(() => {
        try {
            if (proc.exitCode === null && proc.signalCode === null && !proc.killed) {
                proc.kill("SIGKILL");
            }
        } catch {}
    }, 1000);

    if (timer.unref) timer.unref();
}

export function buildArgs(url, options = {}) {
    const opts = options || {};
    const args = ["--ignore-config", "--js-runtimes", "node"];

    if (!opts.extractorRetries && !opts["extractor-retries"]) args.push("--extractor-retries", "3");
    if (!opts.fragmentRetries && !opts["fragment-retries"]) args.push("--fragment-retries", "5");
    if (!opts.socketTimeout && !opts["socket-timeout"]) args.push("--socket-timeout", "10");

    if (!opts.retrySleep && !opts["retry-sleep"]) {
        args.push("--retry-sleep", "fragment:1");
        args.push("--retry-sleep", "extractor:1");
    }

    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.startsWith("_") || INTERNAL_OPTIONS.has(key)) continue;

        const val = opts[key];
        if (val === undefined || val === null || val === "") continue;

        const flag = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

        if (typeof val === "boolean") {
            if (val) {
                args.push(`--${flag}`);
            } else {
                args.push(`--no-${flag}`);
            }
        } else if (Array.isArray(val)) {
            for (let k = 0; k < val.length; k++) {
                if (val[k] !== undefined && val[k] !== null) {
                    args.push(`--${flag}`, String(val[k]));
                }
            }
        } else {
            args.push(`--${flag}`, String(val));
        }
    }

    if (url) args.push(url);
    return args;
}

function parseJsonOutput(str) {
    if (typeof str !== "string") return str;
    const trimmed = str.trim();
    if (!trimmed) return {};

    try {
        return JSON.parse(trimmed);
    } catch {
        const lines = trimmed.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}")) {
                try {
                    return JSON.parse(line);
                } catch {}
            }
        }
        return trimmed;
    }
}

export async function runYtdl(url, options = {}, spawnOptions = {}) {
    ensureExecutable(exePath);

    const maxStdoutSize = options?.maxStdoutSize || 50 * 1024 * 1024;
    const maxStderrSize = options?.maxStderrSize || 10 * 1024 * 1024;
    const processTimeout = options?.timeout || 60_000;
    const args = buildArgs(url, options);

    const proc = spawn(exePath, args, {
        windowsHide: true,
        ...spawnOptions,
        stdio: ["ignore", "pipe", "pipe"]
    });

    return new Promise((resolve, reject) => {
        let isSettled = false;
        let timeoutTimer = null;
        let killTimer = null;

        let stdoutStr = "";
        let stderrStr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;

        const cleanup = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
            if (killTimer) {
                clearTimeout(killTimer);
                killTimer = null;
            }

            if (proc.stdout) {
                proc.stdout.removeAllListeners("data");
                proc.stdout.removeAllListeners("error");
                if (!proc.stdout.destroyed) proc.stdout.destroy();
            }
            if (proc.stderr) {
                proc.stderr.removeAllListeners("data");
                proc.stderr.removeAllListeners("error");
                if (!proc.stderr.destroyed) proc.stderr.destroy();
            }

            proc.removeAllListeners("error");
            proc.removeAllListeners("close");
            proc.removeAllListeners("exit");
        };

        const safeKillProcess = () => {
            if (proc.exitCode !== null || proc.signalCode !== null || proc.killed) {
                return;
            }
            try {
                proc.kill("SIGTERM");
            } catch {}

            killTimer = setTimeout(() => {
                try {
                    if (proc.exitCode === null && proc.signalCode === null && !proc.killed) {
                        proc.kill("SIGKILL");
                    }
                } catch {}
            }, 1000);

            if (killTimer.unref) killTimer.unref();
        };

        const fail = (err) => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            safeKillProcess();
            reject(err);
        };

        const succeed = (data) => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve(data);
        };

        const signal = spawnOptions?.signal || options?.signal;
        let abortHandler = null;
        if (signal) {
            if (signal.aborted) {
                fail(new YTDPLError("Operation aborted", "CANCELLED"));
                return;
            }
            abortHandler = () => {
                fail(new YTDPLError("Operation aborted", "CANCELLED"));
            };
            signal.addEventListener("abort", abortHandler, { once: true });
        }

        proc.stdout?.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxStdoutSize) {
                fail(new YTDPLError(`stdout output limit exceeded (${maxStdoutSize} bytes)`, "EXTRACT_FAILED"));
                return;
            }
            stdoutStr += chunk.toString("utf8");
        });

        proc.stderr?.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes > maxStderrSize) {
                if (stderrStr.length > 4096) {
                    stderrStr = stderrStr.slice(-2048) + chunk.toString("utf8");
                } else {
                    stderrStr += chunk.toString("utf8");
                }
            } else {
                stderrStr += chunk.toString("utf8");
            }
        });

        proc.on("error", (err) => {
            if (err?.code === "ENOENT") {
                isBinaryVerified = false;
            }
            fail(classifyError(err, stderrStr.trim()));
        });

        proc.on("close", (code, signalCode) => {
            if (signal && abortHandler) {
                signal.removeEventListener("abort", abortHandler);
            }

            if (code !== 0) {
                const trimmedStderr = stderrStr.trim();
                const errMsg = trimmedStderr || (signalCode ? `Process killed with signal ${signalCode}` : `Process exited with code ${code}`);
                fail(classifyError(new Error(errMsg), trimmedStderr));
                return;
            }

            const parsed = parseJsonOutput(stdoutStr);
            succeed(parsed);
        });

        if (processTimeout > 0) {
            timeoutTimer = setTimeout(() => {
                fail(new YTDPLError(`yt-dlp process timed out after ${processTimeout}ms`, "TIMEOUT"));
            }, processTimeout);
            if (timeoutTimer.unref) timeoutTimer.unref();
        }
    });
}

export async function executeWithRetry(url, baseOptions = {}, spawnOptions = {}) {
    const isTikTok = isTikTokUrl(url);
    const maxAttempts = baseOptions?.retryCount !== undefined
        ? Math.max(1, Math.min(baseOptions.retryCount, 10))
        : (isTikTok ? 4 : 2);

    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const signal = spawnOptions?.signal || baseOptions?.signal;
        if (signal?.aborted) {
            throw new YTDPLError("Operation aborted by caller", "CANCELLED");
        }

        if (attempt > 0) {
            const baseDelay = 500;
            const maxDelay = 4000;
            const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1)) + Math.random() * 200;
            await new Promise((resolve) => setTimeout(resolve, delay));

            if (signal?.aborted) {
                throw new YTDPLError("Operation aborted by caller", "CANCELLED");
            }
        }

        let currentOptions = { ...baseOptions };

        if (isTikTok) {
            const tikTokArgs = getTikTokExtractorArgs();
            currentOptions = { ...tikTokArgs, ...currentOptions };

            if (attempt === 0) {
                const cookieOpt = resolveCookieOption(currentOptions.cookies);
                if (cookieOpt) {
                    currentOptions[cookieOpt.flag] = cookieOpt.value;
                }
            } else if (attempt === 1) {
                currentOptions.userAgent = USER_AGENTS[attempt % USER_AGENTS.length];
                currentOptions.impersonate = "chrome";
            } else if (attempt === 2) {
                const browserCookie = getFallbackBrowserCookies(0);
                if (browserCookie) {
                    currentOptions[browserCookie.flag] = browserCookie.value;
                }
            } else if (attempt === 3) {
                delete currentOptions.impersonate;
                delete currentOptions.cookiesFromBrowser;
                currentOptions.userAgent = USER_AGENTS[0];
            }
        } else {
            if (attempt > 0) {
                currentOptions.userAgent = USER_AGENTS[attempt % USER_AGENTS.length];
            }
        }

        try {
            return await runYtdl(url, currentOptions, spawnOptions);
        } catch (err) {
            lastError = err instanceof YTDPLError ? err : classifyError(err);

            if (
                lastError.code === "NON_RETRYABLE" ||
                lastError.code === "LOGIN_REQUIRED" ||
                lastError.code === "FORBIDDEN" ||
                lastError.code === "CANCELLED" ||
                isNonRetryableError(lastError.message)
            ) {
                throw lastError;
            }

            if (attempt === maxAttempts - 1) {
                break;
            }
        }
    }

    throw lastError || new YTDPLError("Execution failed after retries", "EXTRACT_FAILED");
}

export function exec(url, options = {}, spawnOptions = {}) {
    ensureExecutable(exePath);
    const args = buildArgs(url, options);
    return spawn(exePath, args, {
        windowsHide: true,
        ...spawnOptions,
    });
}

export default async function ytdl(url, options = {}, spawnOptions = {}) {
    if (!url || typeof url !== "string") {
        throw new YTDPLError("Invalid URL provided to ytdl", "NON_RETRYABLE");
    }

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        throw new YTDPLError("Empty URL provided to ytdl", "NON_RETRYABLE");
    }

    try {
        const parsed = new URL(trimmedUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new YTDPLError(`Unsupported protocol: ${parsed.protocol}`, "NON_RETRYABLE");
        }
    } catch (err) {
        if (err instanceof YTDPLError) throw err;
        throw new YTDPLError("Malformed URL provided to ytdl", "NON_RETRYABLE");
    }

    await verifyAndEnsureBinary();

    let finalUrl = trimmedUrl;
    if (isTikTokUrl(trimmedUrl)) {
        finalUrl = await expandTikTokUrl(trimmedUrl, options?.userAgent || USER_AGENTS[0]);
    }

    return await executeWithRetry(finalUrl, options, spawnOptions);
}