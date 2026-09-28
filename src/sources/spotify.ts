import { SourceResolver, TrackMetadata } from "./resolver.js";
import { securityManager } from "../utils/security.js";

export type SpotifyEntityType = "track" | "album" | "playlist" | "episode" | "show";

export interface ParsedSpotifyUrl {
    readonly type: SpotifyEntityType;
    readonly id: string;
    readonly canonicalUrl: string;
    readonly rawUrl: string;
}

export interface SearchProvider {
    search(query: string, options?: Record<string, unknown>): Promise<TrackMetadata[]>;
}

export type StreamExtractorFn = (youtubeUrl: string, options?: Record<string, unknown>) => Promise<string>;

export interface SpotifyMetadata {
    readonly title: string;
    readonly artist: string;
    readonly primaryArtist: string;
    readonly featuredArtists: readonly string[];
    readonly durationSec: number;
    readonly thumbnail?: string;
    readonly spotifyUrl: string;
    readonly album?: string;
    readonly releaseYear?: number;
    readonly explicit?: boolean;
    readonly isrc?: string;
    readonly isLive?: boolean;
}

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export interface SpotifyResolverOptions {
    maxCollectionTracks?: number;
    concurrency?: number;
    logger?: Logger;
    cacheTtlMs?: number;
    cacheMaxSize?: number;
    requestTimeoutMs?: number;
    spotifyClientId?: string;
    spotifyClientSecret?: string;
    spotifyApiBaseUrl?: string;
    spotifyAuthUrl?: string;
    circuitBreakerThreshold?: number;
    circuitBreakerResetMs?: number;
    streamExtractor?: StreamExtractorFn;
}

export interface CacheStats {
    readonly hits: number;
    readonly misses: number;
    readonly evictions: number;
    readonly size: number;
    readonly maxSize: number;
}

export interface FetchOptions extends RequestInit {
    readonly timeoutMs?: number;
    readonly maxRetries?: number;
    readonly maxSizeBytes?: number;
}

export type SpotifyErrorCode =
    | "INVALID_URL"
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "RATE_LIMIT"
    | "METADATA_FAILED"
    | "YOUTUBE_NOT_FOUND"
    | "UNSUPPORTED_TYPE"
    | "COLLECTION_EMPTY"
    | "RESOLVE_FAILED"
    | "CIRCUIT_OPEN"
    | "DIRECT_PLAYBACK_UNAVAILABLE";

const SPOTIFY_URL_REGEX =
    /^(?:https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2,8}(?:-[a-z]{2,8})?\/|embed\/)*(track|album|playlist|episode|show)\/([a-zA-Z0-9]{15,32})|spotify:(track|album|playlist|episode|show):([a-zA-Z0-9]{15,32}))/i;
const SHORT_LINK_REGEX =
    /^https?:\/\/(?:spotify\.link|spotify\.app\.link)\/[a-zA-Z0-9_-]+/i;

const GENERIC_TITLES_SET = new Set([
    "stay", "hello", "angel", "monster", "home", "hero", "beautiful", "paradise", "dream",
    "love", "run", "one", "hold on", "forever", "smile", "rain", "ghost", "alive",
    "closer", "sugar", "memories", "shine", "fly", "without you", "stay with me",
    "thinking out loud", "alone", "sorry", "crazy", "believe", "happy", "golden",
    "fire", "light", "star", "radioactive", "bad", "toxic", "thunder", "despacito",
    "shape of you", "clarity", "yellow", "payphone", "mirrors", "halo", "royals",
    "timber", "counting stars", "demons", "sail", "let it go", "fancy", "chandelier",
    "habits", "take me to church", "blank space", "uptown funk", "see you again",
    "cheerleader", "lean on", "watch me", "can't feel my face", "hills", "hotline bling",
    "stressed out", "work", "7 years", "cheap thrills", "one dance", "pander", "starboy",
    "fake love", "unforgettable", "believer", "humble", "rockstar", "havana", "god's plan",
    "psycho", "sad", "lucid dreams", "girls like you", "in my feelings", "sicko mode",
    "thank u next", "without me", "sunflower", "7 rings", "shallow", "old town road",
    "bad guy", "truth hurts", "senorita", "circles", "dance monkey", "rooxanne",
    "blinding lights", "say so", "savage", "waterable", "cardigan", "dynamite", "mood",
    "drivers license", "peaches", "good 4 u", "industry baby", "easy on me", "abcdeu",
    "as it was", "first class", "about damn time", "running up that hill", "bad habit",
    "unholy", "anti hero", "kill bill", "flowers", "last night", "vampire", "fukumean",
    "paint the town red", "cruel summer", "greedy", "lovin on me", "i know", "yes and",
    "carnival", "we can't be friends", "like that", "espresso", "fortnight",
    "please please please", "birds of a feather", "not like us"
]);

export class SpotifyResolverError extends Error {
    constructor(
        message: string,
        public readonly code: SpotifyErrorCode,
        public override readonly cause?: unknown
    ) {
        super(message);
        this.name = "SpotifyResolverError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

const toBase64 = (s: string): string =>
    typeof globalThis.btoa === "function"
        ? globalThis.btoa(s)
        : Buffer.from(s).toString("base64");

export class ConsoleLogger implements Logger {
    private static readonly LOG_LEVELS = ["debug", "info", "warn", "error", "none"];
    private readonly levelIndex: number;

    constructor(level: "debug" | "info" | "warn" | "error" | "none" = "warn") {
        this.levelIndex = ConsoleLogger.LOG_LEVELS.indexOf(level);
    }

    private log(lvl: number, method: "debug" | "info" | "warn" | "error", msg: string, args: unknown[]) {
        if (this.levelIndex <= lvl) console[method](`[SpotifyResolver:${method.toUpperCase()}] ${msg}`, ...args);
    }

    debug(m: string, ...a: unknown[]) { this.log(0, "debug", m, a); }
    info(m: string, ...a: unknown[]) { this.log(1, "info", m, a); }
    warn(m: string, ...a: unknown[]) { this.log(2, "warn", m, a); }
    error(m: string, ...a: unknown[]) { this.log(3, "error", m, a); }
}

export class CircuitBreaker {
    private failures = 0;
    private lastFailureTime = 0;
    private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

    constructor(private readonly threshold = 5, private readonly resetMs = 30000) {}

    canExecute(): boolean {
        if (this.state === "OPEN") {
            if (Date.now() - this.lastFailureTime > this.resetMs) {
                this.state = "HALF_OPEN";
                return true;
            }
            return false;
        }
        return true;
    }

    recordSuccess(): void {
        this.failures = 0;
        this.state = "CLOSED";
    }

    recordFailure(): void {
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.failures >= this.threshold) this.state = "OPEN";
    }

    getState(): "CLOSED" | "OPEN" | "HALF_OPEN" { return this.state; }
}

export class Singleflight<T = any> {
    private readonly inFlight = new Map<string, Promise<any>>();

    async do<R = T>(key: string, timeoutMs: number, fn: (signal?: AbortSignal) => Promise<R>): Promise<R> {
        const existing = this.inFlight.get(key);
        if (existing) return existing;

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const executionPromise = fn(controller.signal);
        const timeoutPromise = new Promise<never>((_, reject) => {
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new SpotifyResolverError(`Singleflight execution timed out after ${timeoutMs}ms`, "TIMEOUT"));
                }, timeoutMs);
            }
        });

        const promise = Promise.race([executionPromise, timeoutPromise]).finally(() => {
            if (timer) clearTimeout(timer);
            this.inFlight.delete(key);
        });

        executionPromise.catch(() => {});
        this.inFlight.set(key, promise);
        return promise;
    }

    clear(): void { this.inFlight.clear(); }
}

interface CacheEntry<T> {
    readonly value: T;
    readonly expiry: number;
}

export class LazyLRUCache<T> {
    private store = new Map<string, CacheEntry<T>>();
    private hits = 0;
    private misses = 0;
    private evictions = 0;

    constructor(private readonly ttlMs = 21600000, private readonly maxSize = 1000) {}

    get(key: string): T | undefined {
        const entry = this.store.get(key);
        if (!entry || Date.now() > entry.expiry) {
            if (entry) this.store.delete(key);
            this.misses++;
            return undefined;
        }
        this.hits++;
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    set(key: string, data: T): void {
        this.sweepExpired();
        if (this.store.has(key)) {
            this.store.delete(key);
        } else if (this.store.size >= this.maxSize) {
            const firstKey = this.store.keys().next().value;
            if (firstKey !== undefined) {
                this.store.delete(firstKey);
                this.evictions++;
            }
        }
        this.store.set(key, { value: data, expiry: Date.now() + this.ttlMs });
    }

    private sweepExpired(): void {
        const now = Date.now();
        let checked = 0;
        for (const [k, v] of this.store.entries()) {
            if (checked++ > 30) break;
            if (now > v.expiry) this.store.delete(k);
        }
    }

    clear(): void {
        this.store.clear();
        this.hits = this.misses = this.evictions = 0;
    }

    destroy(): void { this.clear(); }

    getStats(): CacheStats {
        return { hits: this.hits, misses: this.misses, evictions: this.evictions, size: this.store.size, maxSize: this.maxSize };
    }
}

function levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    const m = a.length;
    const n = b.length;
    const dp = new Int32Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;

    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = dp[j];
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
            prev = temp;
        }
    }
    return dp[n];
}

function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    const dist = levenshteinDistance(a, b);
    return Math.max(0, 1 - dist / maxLen);
}

function jaroWinklerSimilarity(s1: string, s2: string, p = 0.1): number {
    if (s1 === s2) return 1.0;
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0.0;

    const matchDist = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
    const s1Matches = new Array<boolean>(len1).fill(false);
    const s2Matches = new Array<boolean>(len2).fill(false);

    let matches = 0;
    for (let i = 0; i < len1; i++) {
        const start = Math.max(0, i - matchDist);
        const end = Math.min(i + matchDist + 1, len2);
        for (let j = start; j < end; j++) {
            if (s2Matches[j] || s1[i] !== s2[j]) continue;
            s1Matches[i] = true;
            s2Matches[j] = true;
            matches++;
            break;
        }
    }

    if (matches === 0) return 0.0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
    }

    const m = matches;
    const jaro = (m / len1 + m / len2 + (m - transpositions / 2) / m) / 3.0;

    let l = 0;
    const maxL = Math.min(4, Math.min(len1, len2));
    for (let i = 0; i < maxL; i++) {
        if (s1[i] === s2[i]) l++;
        else break;
    }

    return jaro + l * p * (1.0 - jaro);
}

function getTokenOverlapScore(s1: string, s2: string): number {
    if (!s1 || !s2) return 0.0;
    const tokens1 = new Set(s1.split(" ").filter(Boolean));
    const tokens2 = new Set(s2.split(" ").filter(Boolean));
    if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

    let intersection = 0;
    for (const t of tokens1) {
        if (tokens2.has(t)) intersection++;
    }

    const union = new Set([...tokens1, ...tokens2]).size;
    return union === 0 ? 0 : intersection / union;
}

function normalizeText(text: string): string {
    if (!text || typeof text !== "string") return "";
    let normalized = text.normalize("NFKC");
    normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    normalized = normalized.replace(/[’‘'`]/g, "'").replace(/[–—−‒―]/g, "-").toLowerCase();
    normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, " ");
    return normalized.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
    if (!text || typeof text !== "string") return "";
    return text
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/’/gi, "'")
        .replace(/‘/gi, "'")
        .replace(/“/gi, '"')
        .replace(/”/gi, '"')
        .replace(/\//gi, "/")
        .replace(/\u00a0/gi, " ")
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseIsoDuration(durationStr: string): number {
    if (!durationStr || typeof durationStr !== "string") return 0;
    const match = durationStr.trim().match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (!match) return 0;
    const hours = parseInt(match[1] || "0", 10);
    const minutes = parseInt(match[2] || "0", 10);
    const seconds = parseFloat(match[3] || "0");
    return Math.floor(hours * 3600 + minutes * 60 + Math.round(seconds));
}

function detectVariantFlags(text: string) {
    if (!text || typeof text !== "string") {
        return {
            isLive: false,
            isRemix: false,
            isCover: false,
            isKaraoke: false,
            isInstrumental: false,
            isSpedUpSlowed: false,
            isGarbage: false,
            isAcoustic: false,
        };
    }
    const t = text.toLowerCase();

    const isFalseLive = /\b(live (your|my|our|a|the)?\s*(life|forever|fast|free|high|it|like|for|with)|alive|live is life|live to|live and let|long live|live in peace|live or die)\b/i.test(t);
    const isLive = !isFalseLive && /\b(live|in concert|unplugged|on tour|live session|live performance|live at|live from|live in|mtv unplugged|live acoustic|live set)\b/i.test(t);

    const isRemix = /\b(remix|rmx|re-mix|club mix|extended mix|dance mix|vip mix|bootleg|flip|dub mix|edit|radio edit|extended edit|club edit)\b/i.test(t);
    const isCover = /\b(cover|tribute|fanmade|fan-made|ai cover|style of|originally by|in the style of|synthesizer cover|orchestral cover|band cover|acoustic cover)\b/i.test(t);
    const isKaraoke = /\b(karaoke|backing track|sing along|minus one|no vocals|acapella|a cappella|vocal only|piano cover|guitar cover)\b/i.test(t);
    const isInstrumental = /\b(instrumental|backing track|no vocals|piano version|guitar version|orchestral version|orchestral|synthesizer version)\b/i.test(t);
    const isSpedUpSlowed = /\b(nightcore|sped up|speed up|slowed|reverb|8d|3d audio|bass boosted|pitch shifted|lofi remix|lofi cover|lofi version|lo-fi)\b/i.test(t);
    const isGarbage = /\b(reaction|review|tutorial|how to play|guitar lesson|piano lesson|teaser|trailer|parody|shorts?|unboxing|behind the scenes|making of|interview|commentary|podcast|vlog|tier list|album review|reaction video|amv|fan edit)\b/i.test(t);
    const isAcoustic = /\b(acoustic|unplugged|stripped)\b/i.test(t);

    return { isLive, isRemix, isCover, isKaraoke, isInstrumental, isSpedUpSlowed, isGarbage, isAcoustic };
}

function cleanTitleString(title: string): string {
    if (!title) return "";
    const decoded = decodeHtmlEntities(title);
    const cleaned = decoded
        .replace(/[([]\s*(?:remastered|\d{4}\s+remaster|deluxe|edition|anniversary|hd|hq|4k|official music video|official video|official audio|lyric video|lyrics|audio|video|visualizer)[^\])]*[\])]/gi, "")
        .replace(/\s*[-–—]\s*(?:remastered|\d{4}\s+remaster|deluxe\s+edition|anniversary\s+edition|official\s+(?:video|audio|music\s+video|lyric\s+video)|lyric\s+video)\b/gi, "")
        .replace(/\s*[-–—]\s*(?:song|episode|podcast|track)?(?:\s*and lyrics)?\s*by\s*.*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.length > 0 ? cleaned : decoded;
}

function extractArtistsFromSpotifyObject(raw: Record<string, unknown>): string[] {
    const artists: string[] = [];
    const add = (name: unknown) => {
        if (typeof name === "string") {
            const decoded = decodeHtmlEntities(name).trim();
            if (decoded && !["unknown artist", "spotify", "unknown publisher"].includes(decoded.toLowerCase()) && !artists.includes(decoded)) {
                artists.push(decoded);
            }
        }
    };
    const extract = (val: unknown) => {
        if (!val) return;
        if (typeof val === "string") return add(val);
        if (Array.isArray(val)) return val.forEach(extract);
        if (typeof val === "object") {
            const obj = val as Record<string, unknown>;
            if (typeof obj.name === "string") add(obj.name);
            else if (typeof obj.profile === "object" && obj.profile && typeof (obj.profile as any).name === "string") add((obj.profile as any).name);
            else if (typeof obj.text === "string") add(obj.text);
            else if (typeof obj.publisher === "string") add(obj.publisher);

            ["items", "nodes", "artists", "artistsV2", "credits", "performers"].forEach(k => k in obj && extract(obj[k]));
        }
    };

    for (const k of ["artists", "artistsV2", "credits", "performers", "author", "authors"]) {
        if (raw[k]) { extract(raw[k]); if (artists.length) break; }
    }
    if (!artists.length && raw.album && typeof raw.album === "object") {
        for (const k of ["artists", "artistsV2"]) {
            if ((raw.album as any)[k]) { extract((raw.album as any)[k]); if (artists.length) break; }
        }
    }
    if (!artists.length) {
        for (const k of ["subtitle", "byline", "artists_description", "artist_name", "author_name", "creator", "publisher"]) {
            if (typeof raw[k] === "string" && (raw[k] as string).trim()) {
                (raw[k] as string).split(/,|\s+(?:&|feat\.?|ft\.?|with|and|x)\s+/i).forEach(add);
                if (artists.length) break;
            }
        }
    }
    if (!artists.length) {
        for (const pk of ["show", "owner", "channel"]) {
            const parent = raw[pk] as Record<string, unknown>;
            if (parent && typeof parent === "object") {
                for (const sk of ["name", "publisher", "display_name"]) {
                    if (typeof parent[sk] === "string") { add(parent[sk]); break; }
                }
                if (artists.length) break;
            }
        }
    }
    return artists;
}

function parseOembedArtistAndTitle(json: Record<string, unknown>) {
    const rawTitle = typeof json.title === "string" ? decodeHtmlEntities(json.title.trim()) : "";
    let authorName = typeof json.author_name === "string" ? decodeHtmlEntities(json.author_name.trim()) : "";
    if (["spotify", "unknown artist", "unknown publisher"].includes(authorName.toLowerCase())) authorName = "";

    const cleaned = rawTitle.replace(/\s*\|\s*Spotify\s*$/i, "").trim();
    let extractedTitle = cleaned;
    let extractedArtists: string[] = [];

    const splitArtists = (s: string) => s.split(/,|\s+(?:&|feat\.?|ft\.?|with|and|x)\s+/i).map(x => x.trim()).filter(Boolean);

    if (authorName) extractedArtists = splitArtists(authorName);

    const byMatch = cleaned.match(/^(.*?)\s*[-–—]\s*(?:song|episode|podcast|track)?(?:\s*and lyrics)?\s*by\s*(.*?)$/i) || cleaned.match(/^(.*?)\s+by\s+(.*?)$/i);
    if (byMatch) {
        extractedTitle = byMatch[1].trim();
        if (!extractedArtists.length) extractedArtists = splitArtists(byMatch[2].trim());
    }

    return {
        title: extractedTitle || rawTitle,
        artist: extractedArtists.join(", "),
        primaryArtist: extractedArtists[0] || "",
        featuredArtists: extractedArtists.slice(1)
    };
}

function adaptiveDurationTolerance(durSec: number, isLive = false): number {
    if (durSec <= 0) return 999999;
    if (isLive) return 20;
    if (durSec <= 90) return 3;
    if (durSec <= 300) return Math.min(6, Math.max(3, Math.round(durSec * 0.02)));
    if (durSec <= 1200) return Math.min(15, Math.max(6, Math.round(durSec * 0.02)));
    return Math.min(30, Math.round(durSec * 0.015));
}

function isValidCandidate(item: TrackMetadata, meta: SpotifyMetadata, logger?: Logger): boolean {
    if (!item || !item.title) return false;

    const candTitle = item.title;
    const candAuthor = item.author || (item as any).channel || (item as any).uploader || "";
    const candText = `${candTitle} ${candAuthor}`;

    const metaFlags = detectVariantFlags(meta.title);
    const candFlags = detectVariantFlags(candText);

    if (candFlags.isGarbage && !metaFlags.isGarbage) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is garbage/tutorial/reaction`);
        return false;
    }

    if (candFlags.isSpedUpSlowed && !metaFlags.isSpedUpSlowed) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is sped up/slowed/nightcore`);
        return false;
    }

    if (candFlags.isKaraoke && !metaFlags.isKaraoke) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is karaoke/backing track`);
        return false;
    }

    if (candFlags.isCover && !metaFlags.isCover) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is a cover`);
        return false;
    }

    if (candFlags.isInstrumental && !metaFlags.isInstrumental && !metaFlags.isKaraoke) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is instrumental`);
        return false;
    }

    if ((item.isLive === true || candFlags.isLive) && !(meta.isLive || metaFlags.isLive)) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is live performance`);
        return false;
    }

    if (candFlags.isRemix && !metaFlags.isRemix) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is remix/edit`);
        return false;
    }

    if (candFlags.isAcoustic && !metaFlags.isAcoustic) {
        logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate is acoustic`);
        return false;
    }

    if (meta.durationSec > 0 && item.duration > 0) {
        const diff = Math.abs(item.duration - meta.durationSec);
        const maxDiff = adaptiveDurationTolerance(meta.durationSec, meta.isLive || metaFlags.isLive);
        if (diff > maxDiff) {
            logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Duration diff ${diff}s exceeds max tolerance ${maxDiff}s (meta: ${meta.durationSec}s vs cand: ${item.duration}s)`);
            return false;
        }
    }

    // Strict Primary Artist Guard: If meta has a valid primary artist, candidate text MUST contain or closely match primary artist
    const mPrimaryNorm = normalizeText(meta.primaryArtist);
    if (mPrimaryNorm && !["unknown artist", "spotify", "unknown publisher"].includes(mPrimaryNorm)) {
        const cCombinedNorm = normalizeText(`${candTitle} ${candAuthor}`);
        const inCombined = cCombinedNorm.includes(mPrimaryNorm);
        const sim = jaroWinklerSimilarity(mPrimaryNorm, cCombinedNorm);
        if (!inCombined && sim < 0.70) {
            logger?.debug(`[CandidateFilter] Hard Reject "${candTitle}": Candidate text does not contain primary artist "${meta.primaryArtist}"`);
            return false;
        }
    }

    return true;
}

function scoreCandidate(
    result: TrackMetadata,
    meta: SpotifyMetadata,
    logger?: Logger
): { score: number; breakdown: string; passesMandatory: boolean; reason: string } {
    const candidateIsrc = (result as unknown as Record<string, unknown>).isrc;
    const candTitle = result.title || "";
    const rawAuthor = result.author || (result as unknown as Record<string, unknown>).channel || (result as unknown as Record<string, unknown>).uploader || "";
    const candAuthor = typeof rawAuthor === "string" ? rawAuthor : (typeof (rawAuthor as any)?.name === "string" ? (rawAuthor as any).name : String(rawAuthor ?? ""));
    const candChannel = String((result as unknown as Record<string, unknown>).channel || (result as unknown as Record<string, unknown>).uploader || candAuthor);

    if (
        meta.isrc &&
        typeof candidateIsrc === "string" &&
        candidateIsrc.trim() &&
        meta.isrc.trim().toUpperCase() === candidateIsrc.trim().toUpperCase()
    ) {
        const diff = Math.abs(result.duration - meta.durationSec);
        const maxTol = adaptiveDurationTolerance(meta.durationSec, meta.isLive);
        if (meta.durationSec === 0 || diff <= maxTol) {
            return {
                score: 100,
                breakdown: "ISRC:100 (Exact ISRC match)",
                passesMandatory: true,
                reason: "Exact ISRC match",
            };
        }
    }

    const mCleanTitle = cleanTitleString(meta.title);
    const cCleanTitle = cleanTitleString(candTitle);

    const mTitleNorm = normalizeText(mCleanTitle);
    const cTitleNorm = normalizeText(cCleanTitle);

    const mPrimaryNorm = normalizeText(meta.primaryArtist);
    const cAuthorNorm = normalizeText(candAuthor);
    const cCombinedNorm = normalizeText(`${candTitle} ${candAuthor}`);

    let titleScore = 0;
    if (mTitleNorm && cTitleNorm) {
        const jwTitle = jaroWinklerSimilarity(mTitleNorm, cTitleNorm);
        const levTitle = levenshteinSimilarity(mTitleNorm, cTitleNorm);
        const tokenTitle = getTokenOverlapScore(mTitleNorm, cTitleNorm);

        let bestTitleSim = Math.max(jwTitle, levTitle, tokenTitle);
        if (mTitleNorm === cTitleNorm) bestTitleSim = 1.0;
        else if (cTitleNorm.includes(mTitleNorm) || mTitleNorm.includes(cTitleNorm)) {
            bestTitleSim = Math.max(bestTitleSim, 0.90);
        }

        titleScore = Math.round(bestTitleSim * 35);
    }

    let artistScore = 0;
    let primaryMatched = false;

    if (mPrimaryNorm) {
        const jwArtist = jaroWinklerSimilarity(mPrimaryNorm, cAuthorNorm);
        const levArtist = levenshteinSimilarity(mPrimaryNorm, cAuthorNorm);
        const tokenArtist = getTokenOverlapScore(mPrimaryNorm, cAuthorNorm);

        const inAuthor = cAuthorNorm.includes(mPrimaryNorm);
        const inTitle = cCombinedNorm.includes(mPrimaryNorm);

        if (inAuthor) {
            artistScore = 25;
            primaryMatched = true;
        } else if (inTitle) {
            artistScore = 20;
            primaryMatched = true;
        } else {
            const bestArtistSim = Math.max(jwArtist, levArtist, tokenArtist);
            if (bestArtistSim >= 0.75) {
                artistScore = Math.round(bestArtistSim * 22);
                primaryMatched = true;
            } else if (bestArtistSim >= 0.50) {
                artistScore = Math.round(bestArtistSim * 15);
            } else {
                artistScore = Math.round(bestArtistSim * 10);
            }
        }

        if (meta.featuredArtists && meta.featuredArtists.length > 0) {
            let featMatchedCount = 0;
            for (const feat of meta.featuredArtists) {
                const fNorm = normalizeText(feat);
                if (!fNorm) continue;
                if (cCombinedNorm.includes(fNorm) || jaroWinklerSimilarity(fNorm, cCombinedNorm) >= 0.80) {
                    featMatchedCount++;
                }
            }
            const featBonus = Math.round((featMatchedCount / meta.featuredArtists.length) * 10);
            artistScore += featBonus;
        } else if (primaryMatched) {
            artistScore += 10;
        }
    } else {
        artistScore = 20;
        primaryMatched = true;
    }

    artistScore = Math.min(35, artistScore);

    let officialBonus = 0;
    const isTopic = /(\s*-\s*topic|topic)$/i.test(candAuthor) || /(\s*-\s*topic|topic)$/i.test(candChannel);
    const isVevo = /vevo$/i.test(candAuthor) || /vevo$/i.test(candChannel);
    const isOfficialText = /\b(official audio|official video|official lyric video|official music video|official visualizer)\b/i.test(candTitle);

    if (isTopic || isVevo) {
        officialBonus = 12;
        if (isOfficialText) officialBonus = 15;
    } else if (isOfficialText) {
        officialBonus = 10;
    }

    let durScore = 0;
    if (meta.durationSec > 0 && result.duration > 0) {
        const diff = Math.abs(result.duration - meta.durationSec);
        if (diff <= 1) durScore = 15;
        else if (diff <= 3) durScore = 13;
        else if (diff <= 5) durScore = 10;
        else if (diff <= 10) durScore = 6;
        else if (diff <= 15) durScore = 3;
        else durScore = 0;
    } else {
        durScore = 8;
    }

    let albumBonus = 0;
    if (meta.album) {
        const mAlbumNorm = normalizeText(meta.album);
        if (mAlbumNorm && cCombinedNorm.includes(mAlbumNorm)) {
            albumBonus = 5;
        }
    }

    let yearPenalty = 0;
    if (meta.releaseYear && typeof (result as any).releaseYear === "number") {
        const candYear = (result as any).releaseYear;
        const yearDiff = Math.abs(candYear - meta.releaseYear);
        if (yearDiff > 3 && !/\b(remaster|deluxe|anniversary|edition)\b/i.test(candTitle)) {
            yearPenalty = 10;
        } else if (yearDiff > 7 && !/\b(remaster|deluxe|anniversary|edition)\b/i.test(candTitle)) {
            yearPenalty = 20;
        }
    }

    const isGenericTitle =
        mTitleNorm.split(" ").length <= 1 ||
        mTitleNorm.length <= 4 ||
        GENERIC_TITLES_SET.has(mTitleNorm);

    let genericTitlePenalty = 0;
    if (isGenericTitle && !primaryMatched && artistScore < 20) {
        genericTitlePenalty = 40;
    }

    let penalties = yearPenalty + genericTitlePenalty;

    if (mPrimaryNorm && !primaryMatched && artistScore < 12) {
        penalties += 50;
    }

    const rawScore = titleScore + artistScore + officialBonus + durScore + albumBonus - penalties;
    const finalScore = Math.max(0, Math.min(100, Math.round(rawScore)));

    const passesAdaptiveDur =
        meta.durationSec === 0 ||
        result.duration === 0 ||
        Math.abs(result.duration - meta.durationSec) <= adaptiveDurationTolerance(meta.durationSec, meta.isLive);

    const passesTitle = titleScore >= 20;
    const passesArtist = primaryMatched || artistScore >= 20;
    const passesGeneric = !isGenericTitle || artistScore >= 22;

    const passesMandatory = passesAdaptiveDur && passesTitle && passesArtist && passesGeneric && penalties < 30;

    let reason = "Passed mandatory validation";
    if (!passesAdaptiveDur) reason = `Duration difference exceeds adaptive threshold`;
    else if (!passesTitle) reason = `Title similarity too low (${titleScore}/35)`;
    else if (!passesArtist) reason = `Artist mismatch (Primary artist not found)`;
    else if (!passesGeneric) reason = `Generic title requires higher artist match`;
    else if (penalties >= 40) reason = `Excessive penalty (${penalties})`;

    const breakdown = `Title:${titleScore} Art:${artistScore} Off:${officialBonus} Dur:${durScore} Alb:${albumBonus} Pen:-${penalties} => Total:${finalScore}`;

    return { score: finalScore, breakdown, passesMandatory, reason };
}

class SpotifyApiClient {
    private readonly clientId?: string;
    private readonly clientSecret?: string;
    private readonly apiBaseUrl: string;
    private readonly authUrl: string;
    private readonly timeoutMs: number;
    private readonly logger: Logger;
    private readonly circuitBreaker: CircuitBreaker;
    private accessToken?: string;
    private tokenExpiresAt = 0;
    private inFlightTokenRequest?: Promise<string | null>;

    constructor(options: {
        clientId?: string;
        clientSecret?: string;
        apiBaseUrl?: string;
        authUrl?: string;
        logger: Logger;
        timeoutMs: number;
        circuitBreakerThreshold?: number;
        circuitBreakerResetMs?: number;
    }) {
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.apiBaseUrl = options.apiBaseUrl ?? "https://api.spotify.com/v1";
        this.authUrl = options.authUrl ?? "https://accounts.spotify.com/api/token";
        this.logger = options.logger;
        this.timeoutMs = options.timeoutMs;
        this.circuitBreaker = new CircuitBreaker(options.circuitBreakerThreshold ?? 5, options.circuitBreakerResetMs ?? 30000);
    }

    isAvailable(): boolean {
        return Boolean(this.clientId && this.clientSecret) && this.circuitBreaker.canExecute();
    }

    async getToken(signal?: AbortSignal): Promise<string | null> {
        if (!this.isAvailable()) return null;
        if (this.accessToken && Date.now() < this.tokenExpiresAt - 10000) return this.accessToken;
        if (this.inFlightTokenRequest) return this.inFlightTokenRequest;

        return (this.inFlightTokenRequest = (async () => {
            try {
                const res = await fetchWithRetry(this.authUrl, {
                    method: "POST",
                    headers: {
                        Authorization: "Basic " + toBase64(`${this.clientId}:${this.clientSecret}`),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: "grant_type=client_credentials",
                    timeoutMs: this.timeoutMs,
                    signal,
                    maxRetries: 1,
                });
                const json = (await res.json()) as Record<string, unknown>;
                if (typeof json.access_token === "string") {
                    this.accessToken = json.access_token;
                    this.tokenExpiresAt = Date.now() + Math.max(30, (Number(json.expires_in) || 3600) - 30) * 1000;
                    this.circuitBreaker.recordSuccess();
                    return this.accessToken;
                }
                this.circuitBreaker.recordFailure();
            } catch (err) {
                this.accessToken = undefined;
                this.tokenExpiresAt = 0;
                this.circuitBreaker.recordFailure();
                this.logger.debug("Spotify API token fetch failed", err);
            } finally {
                this.inFlightTokenRequest = undefined;
            }
            return null;
        })());
    }

    async apiGet<T>(endpoint: string, query?: Record<string, string | number>, signal?: AbortSignal): Promise<T | null> {
        if (!this.isAvailable()) return null;
        const token = await this.getToken(signal);
        if (!token) return null;

        try {
            let urlStr = `${this.apiBaseUrl}/${endpoint}`;
            if (query) {
                const searchParams = new URLSearchParams();
                for (const [k, v] of Object.entries(query)) {
                    searchParams.append(k, String(v));
                }
                urlStr += `?${searchParams.toString()}`;
            }
            const res = await fetchWithRetry(urlStr, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                timeoutMs: this.timeoutMs,
                signal,
                maxRetries: 1,
            });
            const data = (await res.json()) as T;
            this.circuitBreaker.recordSuccess();
            return data;
        } catch (err) {
            this.circuitBreaker.recordFailure();
            this.logger.debug(`Spotify API request failed for ${endpoint}:`, err);
            return null;
        }
    }

    async getTrack(id: string, signal?: AbortSignal): Promise<SpotifyMetadata | null> {
        const data = await this.apiGet<Record<string, unknown>>(`tracks/${encodeURIComponent(id)}`, undefined, signal);
        return data ? parseSpotifyTrackObject(data, undefined, undefined, this.logger) : null;
    }

    async getEpisode(id: string, signal?: AbortSignal): Promise<SpotifyMetadata | null> {
        const data = await this.apiGet<Record<string, unknown>>(`episodes/${encodeURIComponent(id)}`, undefined, signal);
        return data ? parseSpotifyEpisodeObject(data, this.logger) : null;
    }

    async getPlaylistItems(playlistId: string, maxItems: number, signal?: AbortSignal): Promise<SpotifyMetadata[] | null> {
        return this.fetchPaginatedCollection(
            `playlists/${encodeURIComponent(playlistId)}/tracks`,
            maxItems,
            item => parseSpotifyTrackObject(item, undefined, undefined, this.logger),
            signal
        );
    }

    async getAlbumItems(albumId: string, maxItems: number, signal?: AbortSignal): Promise<SpotifyMetadata[] | null> {
        if (!this.isAvailable()) return null;
        const album = await this.apiGet<Record<string, unknown>>(`albums/${encodeURIComponent(albumId)}`, undefined, signal);
        if (!album) return null;
        return this.fetchPaginatedCollection(
            `albums/${encodeURIComponent(albumId)}/tracks`,
            maxItems,
            track =>
                parseSpotifyTrackObject(
                    track,
                    typeof album.name === "string" ? album.name : undefined,
                    extractImageUrl(album.images),
                    this.logger
                ),
            signal
        );
    }

    async getShowItems(showId: string, maxItems: number, signal?: AbortSignal): Promise<SpotifyMetadata[] | null> {
        return this.fetchPaginatedCollection(
            `shows/${encodeURIComponent(showId)}/episodes`,
            maxItems,
            item => parseSpotifyEpisodeObject(item, this.logger),
            signal
        );
    }

    private async fetchPaginatedCollection(
        endpoint: string,
        maxItems: number,
        parser: (item: Record<string, unknown>) => SpotifyMetadata | null,
        signal?: AbortSignal
    ): Promise<SpotifyMetadata[] | null> {
        if (!this.isAvailable()) return null;
        const limit = 50;
        try {
            const firstPage = await this.apiGet<Record<string, unknown>>(endpoint, { limit, offset: 0 }, signal);
            if (!firstPage || !Array.isArray(firstPage.items) || !firstPage.items.length) return null;

            const results: SpotifyMetadata[] = [];
            const addItem = (raw: unknown) => {
                if (raw && typeof raw === "object") {
                    const norm = parser(raw as Record<string, unknown>);
                    if (norm) results.push(norm);
                }
            };

            for (const item of firstPage.items) {
                addItem(item);
                if (maxItems > 0 && results.length >= maxItems) return results;
            }

            const total = typeof firstPage.total === "number" ? firstPage.total : 0;
            if (!firstPage.next || total <= limit || (maxItems > 0 && results.length >= maxItems)) return results.length ? results : null;

            const targetTotal = maxItems > 0 ? Math.min(total, maxItems) : total;
            const offsets: number[] = [];
            for (let off = limit; off < targetTotal; off += limit) offsets.push(off);

            for (let i = 0; i < offsets.length; i += 5) {
                if (signal?.aborted) break;
                const pages = await Promise.all(
                    offsets.slice(i, i + 5).map(off => this.apiGet<Record<string, unknown>>(endpoint, { limit, offset: off }, signal))
                );
                for (const page of pages) {
                    if (page && Array.isArray(page.items)) {
                        for (const item of page.items) {
                            addItem(item);
                            if (maxItems > 0 && results.length >= maxItems) return results;
                        }
                    }
                }
            }
            return results.length ? results : null;
        } catch {
            return null;
        }
    }
}

function unwrapTrackObject(raw: Record<string, unknown>): Record<string, unknown> {
    if (typeof raw.track === "object" && raw.track) return raw.track as Record<string, unknown>;
    if (typeof raw.itemV2 === "object" && raw.itemV2 && typeof (raw.itemV2 as any).data === "object" && (raw.itemV2 as any).data) return (raw.itemV2 as any).data;
    if (typeof raw.data === "object" && raw.data) return raw.data as Record<string, unknown>;
    return raw;
}

const extractImageUrl = (images: unknown): string | undefined =>
    Array.isArray(images) && images[0] && typeof images[0] === "object" && typeof images[0].url === "string" ? images[0].url : undefined;

function parseSpotifyTrackObject(
    raw?: Record<string, unknown>,
    fallbackAlbum?: string,
    fallbackImage?: string,
    logger?: Logger
): SpotifyMetadata | null {
    if (!raw || typeof raw !== "object") return null;
    const track = unwrapTrackObject(raw);
    if (track.is_local === true) return null;

    const rawName = typeof track.name === "string" ? track.name.trim() : typeof track.title === "string" ? track.title.trim() : "";
    const name = decodeHtmlEntities(rawName);
    if (!name) return null;

    const extractedArtists = extractArtistsFromSpotifyObject(track);
    const primaryArtist = extractedArtists[0] || "";
    const artist = extractedArtists.join(", ");
    const featuredArtists = extractedArtists.slice(1);

    const albumObj = typeof track.album === "object" && track.album ? (track.album as Record<string, unknown>) : undefined;
    const releaseDate = typeof albumObj?.release_date === "string" ? albumObj.release_date : undefined;
    const releaseYear = releaseDate ? (y => isNaN(y) ? undefined : y)(parseInt(releaseDate.slice(0, 4), 10)) : undefined;

    const albumName = fallbackAlbum ?? (typeof albumObj?.name === "string" ? decodeHtmlEntities(albumObj.name) : undefined);
    const thumbnail = fallbackImage ?? extractImageUrl(albumObj?.images) ?? extractImageUrl(track.images);

    const externalUrls = typeof track.external_urls === "object" && track.external_urls ? (track.external_urls as Record<string, unknown>) : undefined;
    const trackId = typeof track.id === "string" ? track.id : "";
    const spotifyUrl = typeof externalUrls?.spotify === "string"
        ? externalUrls.spotify
        : trackId
        ? `https://open.spotify.com/track/${trackId}`
        : typeof track.uri === "string" && track.uri.startsWith("spotify:track:")
        ? `https://open.spotify.com/track/${track.uri.slice(14)}`
        : "";

    const isrc = typeof track.external_ids === "object" && track.external_ids && "isrc" in track.external_ids ? String((track.external_ids as any).isrc).trim() : undefined;
    const duration_ms = typeof track.duration_ms === "number" ? track.duration_ms : typeof track.duration === "number" ? track.duration : 0;
    const durationSec = Math.floor(duration_ms / 1000);

    logger?.debug(`[SpotifyParser] Parsed Track: "${name}" | Artist: "${artist}" | Primary: "${primaryArtist}" | Featured: [${featuredArtists.join(", ")}] | ISRC: ${isrc || "N/A"} | Duration: ${durationSec}s`);

    return {
        title: name,
        artist,
        primaryArtist,
        featuredArtists,
        durationSec,
        thumbnail,
        spotifyUrl,
        album: albumName,
        releaseYear,
        explicit: typeof track.explicit === "boolean" ? track.explicit : undefined,
        isrc,
        isLive: detectVariantFlags(name).isLive
    };
}

function parseSpotifyEpisodeObject(raw: Record<string, unknown>, logger?: Logger): SpotifyMetadata | null {
    if (!raw || typeof raw !== "object") return null;
    const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
    const name = decodeHtmlEntities(rawName);
    if (!name) return null;

    const extractedArtists = extractArtistsFromSpotifyObject(raw);
    const artist = extractedArtists.length ? extractedArtists.join(", ") : "Unknown Publisher";
    const showObj = typeof raw.show === "object" && raw.show ? (raw.show as Record<string, unknown>) : undefined;
    const thumbnail = extractImageUrl(raw.images) ?? extractImageUrl(showObj?.images);

    const externalUrls = typeof raw.external_urls === "object" && raw.external_urls ? (raw.external_urls as Record<string, unknown>) : undefined;
    const spotifyUrl = typeof externalUrls?.spotify === "string" ? externalUrls.spotify : "";
    const duration_ms = typeof raw.duration_ms === "number" ? raw.duration_ms : 0;

    const releaseDate = typeof raw.release_date === "string" ? raw.release_date : undefined;
    const releaseYear = releaseDate ? (y => isNaN(y) ? undefined : y)(parseInt(releaseDate.slice(0, 4), 10)) : undefined;
    const durationSec = Math.floor(duration_ms / 1000);

    logger?.debug(`[SpotifyParser] Parsed Episode: "${name}" | Publisher/Artist: "${artist}" | Duration: ${durationSec}s`);

    return {
        title: name,
        artist,
        primaryArtist: artist,
        featuredArtists: [],
        durationSec,
        thumbnail,
        spotifyUrl,
        releaseYear,
        explicit: typeof raw.explicit === "boolean" ? raw.explicit : undefined,
        isLive: false
    };
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new SpotifyResolverError("Operation aborted", "TIMEOUT"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(new SpotifyResolverError("Operation aborted", "TIMEOUT"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

async function fetchWithRetry(initialUrl: string, options: FetchOptions = {}): Promise<Response> {
    let currentUrl = initialUrl;
    const maxRetries = options.maxRetries ?? 1;
    const timeoutMs = options.timeoutMs ?? 4000;
    const maxSizeBytes = options.maxSizeBytes ?? 5242880;
    let redirectCount = 0;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (options.signal?.aborted) throw new SpotifyResolverError("Request aborted by caller", "TIMEOUT");

        await securityManager.assertPublicHttpUrl(currentUrl);
        const controller = new AbortController();
        const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("Timeout")), timeoutMs) : undefined;
        const onCallerAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onCallerAbort, { once: true });

        try {
            const res = await fetch(currentUrl, {
                ...options,
                redirect: "manual",
                signal: controller.signal,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
                    "Accept-Language": "en-US,en;q=0.9",
                    ...options.headers,
                },
            });

            if (res.status >= 300 && res.status < 400) {
                await res.body?.cancel().catch(() => {});
                if (++redirectCount > 5) throw new SpotifyResolverError("Too many redirects encountered", "NETWORK_ERROR");
                const location = res.headers.get("location");
                if (!location) throw new SpotifyResolverError("Redirect without location header", "NETWORK_ERROR");
                currentUrl = new URL(location, currentUrl).toString();
                attempt--;
                continue;
            }

            if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
                await res.body?.cancel().catch(() => {});
                if (attempt < maxRetries) { await sleep(100 * (1 << attempt), options.signal); continue; }
            }

            if (!res.ok) {
                await res.body?.cancel().catch(() => {});
                throw new SpotifyResolverError(`HTTP ${res.status}: ${res.statusText}`, "NETWORK_ERROR");
            }

            const contentLength = res.headers.get("content-length");
            if (contentLength) {
                const len = parseInt(contentLength, 10);
                if (!isNaN(len) && len > maxSizeBytes) {
                    await res.body?.cancel().catch(() => {});
                    throw new SpotifyResolverError(`Response exceeds max allowed ${maxSizeBytes} bytes`, "NETWORK_ERROR");
                }
            }
            return res;
        } catch (err: unknown) {
            if (err instanceof SpotifyResolverError) {
                if (attempt >= maxRetries) throw err;
                lastError = err;
            } else if (controller.signal.aborted && !options.signal?.aborted) {
                lastError = new SpotifyResolverError(`Request timed out after ${timeoutMs}ms`, "TIMEOUT");
            } else if (options.signal?.aborted) {
                throw new SpotifyResolverError("Request aborted by caller", "TIMEOUT");
            } else {
                lastError = new SpotifyResolverError(`Network fetch failed: ${err instanceof Error ? err.message : String(err)}`, "NETWORK_ERROR");
            }
            if (attempt < maxRetries) await sleep(100 * (1 << attempt), options.signal);
        } finally {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onCallerAbort);
        }
    }
    throw lastError ?? new SpotifyResolverError("Fetch failed after retries", "NETWORK_ERROR");
}

function isStreamUrlExpired(url: string): boolean {
    if (!url || typeof url !== "string") return true;
    if (!url.includes("googlevideo.com") && !url.includes("streamUrl") && !url.includes("/videoplayback")) {
        if (url.includes("youtube.com") || url.includes("youtu.be") || url.includes("spotify.com")) return true;
    }
    try {
        const parsed = new URL(url);
        const exp = parsed.searchParams.get("expire") || parsed.searchParams.get("exp");
        if (exp) {
            const sec = parseInt(exp, 10);
            if (!isNaN(sec)) return Date.now() / 1000 >= sec - 60;
        }
    } catch {}
    return false;
}

function generateSearchQueries(meta: SpotifyMetadata): string[] {
    const cleanTitle = cleanTitleString(meta.title);
    const primaryArtist = meta.primaryArtist ? meta.primaryArtist.trim() : "";
    const featuredArtistsStr = meta.featuredArtists?.length ? meta.featuredArtists.join(" ") : "";
    const allArtistsStr = [primaryArtist, ...meta.featuredArtists].filter(Boolean).join(" ").trim();
    const albumStr = meta.album ? cleanTitleString(meta.album) : "";

    const rawQueries: string[] = [];

    if (meta.isrc?.trim()) {
        rawQueries.push(`isrc:${meta.isrc.trim()}`);
        rawQueries.push(`"${meta.isrc.trim()}"`);
    }

    if (cleanTitle && primaryArtist) {
        if (allArtistsStr) {
            rawQueries.push(`"${cleanTitle}" ${allArtistsStr}`);
            rawQueries.push(`${cleanTitle} ${allArtistsStr} official audio`);
            rawQueries.push(`${primaryArtist} - Topic ${cleanTitle}`);
            rawQueries.push(`${allArtistsStr} ${cleanTitle}`);
            rawQueries.push(`${cleanTitle} ${primaryArtist}`);
            rawQueries.push(`${primaryArtist} ${cleanTitle}`);
        } else {
            rawQueries.push(`"${cleanTitle}" "${primaryArtist}"`);
            rawQueries.push(`${cleanTitle} ${primaryArtist} official audio`);
            rawQueries.push(`${primaryArtist} - Topic ${cleanTitle}`);
            rawQueries.push(`${cleanTitle} ${primaryArtist}`);
        }

        if (albumStr && albumStr.toLowerCase() !== cleanTitle.toLowerCase()) {
            rawQueries.push(`"${albumStr}" ${cleanTitle} ${primaryArtist}`);
        }

        if (meta.releaseYear) {
            rawQueries.push(`${cleanTitle} ${primaryArtist} ${meta.releaseYear}`);
        }

        if (featuredArtistsStr) {
            rawQueries.push(`${cleanTitle} feat ${featuredArtistsStr} ${primaryArtist}`);
        }

        if (cleanTitle.toLowerCase() !== meta.title.toLowerCase()) {
            rawQueries.push(`${meta.title} ${primaryArtist}`);
        }
    } else if (cleanTitle) {
        rawQueries.push(`"${cleanTitle}" official audio`);
        rawQueries.push(`${cleanTitle} official audio`);
        rawQueries.push(`${cleanTitle}`);
    }

    const uniqueQueries: string[] = [];
    const seen = new Set<string>();

    for (const q of rawQueries) {
        const norm = q.toLowerCase().trim().replace(/\s+/g, " ");
        if (norm && !seen.has(norm)) {
            seen.add(norm);
            uniqueQueries.push(q);
        }
    }

    return uniqueQueries;
}

function extractCandidateId(item: TrackMetadata, streamUrl: string): string {
    const obj = item as unknown as Record<string, unknown>;
    if (typeof obj.id === "string" && obj.id) return obj.id;

    const urlStr = streamUrl || (typeof obj.url === "string" ? obj.url : "");
    if (urlStr) {
        const match = urlStr.match(/(?:v=|\/embed\/|\/watch\?v=|youtu\.be\/|\/v\/)([a-zA-Z0-9_-]{11})/i);
        if (match?.[1]) return match[1];
        return urlStr;
    }
    return `${item.title}:${item.author}`;
}

function findTrackEntityInObject(obj: any, depth = 0): Record<string, unknown> | null {
    if (!obj || typeof obj !== "object" || depth > 8) return null;

    if (
        typeof obj.name === "string" &&
        (Array.isArray(obj.artists) || Array.isArray(obj.artistsV2) || typeof obj.duration_ms === "number" || typeof obj.duration === "number")
    ) {
        return obj as Record<string, unknown>;
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            const res = findTrackEntityInObject(item, depth + 1);
            if (res) return res;
        }
    } else {
        for (const k of Object.keys(obj)) {
            if (["track", "item", "entity", "data", "entities"].includes(k)) {
                const res = findTrackEntityInObject(obj[k], depth + 1);
                if (res) return res;
            }
        }
    }
    return null;
}

export class SpotifyResolver implements SourceResolver {
    public readonly name = "SpotifyResolver";

    private readonly searchProvider: SearchProvider;
    private readonly logger: Logger;
    private readonly maxCollectionTracks: number;
    private readonly requestTimeoutMs: number;
    private readonly spotifyApiClient: SpotifyApiClient;
    private readonly streamExtractor?: StreamExtractorFn;

    private readonly metadataCache: LazyLRUCache<SpotifyMetadata>;
    private readonly searchCache: LazyLRUCache<TrackMetadata[]>;
    private readonly collectionCache: LazyLRUCache<SpotifyMetadata[]>;
    private readonly singleflight = new Singleflight<any>();

    constructor(searchProvider: SearchProvider, options: SpotifyResolverOptions = {}) {
        if (!searchProvider || typeof searchProvider.search !== "function") {
            throw new SpotifyResolverError("Invalid SearchProvider supplied", "INVALID_URL");
        }

        this.searchProvider = searchProvider;
        this.logger = options.logger ?? new ConsoleLogger("warn");
        this.maxCollectionTracks = Math.max(0, options.maxCollectionTracks ?? 0);
        this.requestTimeoutMs = options.requestTimeoutMs ?? 4000;
        this.streamExtractor = options.streamExtractor;

        this.spotifyApiClient = new SpotifyApiClient({
            clientId: options.spotifyClientId ?? (typeof process !== "undefined" ? process.env?.SPOTIFY_CLIENT_ID : undefined),
            clientSecret: options.spotifyClientSecret ?? (typeof process !== "undefined" ? process.env?.SPOTIFY_CLIENT_SECRET : undefined),
            apiBaseUrl: options.spotifyApiBaseUrl,
            authUrl: options.spotifyAuthUrl,
            logger: this.logger,
            timeoutMs: this.requestTimeoutMs,
            circuitBreakerThreshold: options.circuitBreakerThreshold,
            circuitBreakerResetMs: options.circuitBreakerResetMs,
        });

        const ttlMs = options.cacheTtlMs ?? 21600000;
        const maxSize = options.cacheMaxSize ?? 1000;

        this.metadataCache = new LazyLRUCache<SpotifyMetadata>(ttlMs, maxSize);
        this.searchCache = new LazyLRUCache<TrackMetadata[]>(ttlMs, maxSize);
        this.collectionCache = new LazyLRUCache<SpotifyMetadata[]>(ttlMs, maxSize);
    }

    public canResolve(url: string): boolean {
        if (!url || typeof url !== "string" || url.length > 2048) return false;
        const trimmed = url.trim();
        return SPOTIFY_URL_REGEX.test(trimmed) || SHORT_LINK_REGEX.test(trimmed);
    }

    public async resolve(url: string, options: Record<string, unknown> = {}): Promise<TrackMetadata | TrackMetadata[]> {
        if (!url || typeof url !== "string" || url.length > 2048) throw new SpotifyResolverError("Invalid Spotify URL", "INVALID_URL");
        const parsed = this.parseSpotifyUrl(await this.resolveRedirectIfNeeded(url.trim(), options.signal as AbortSignal | undefined));
        if (!parsed) throw new SpotifyResolverError("Invalid Spotify URL or URI format", "INVALID_URL");

        return await this.singleflight.do(`resolve:${parsed.type}:${parsed.id}`, 60000, async () => {
            if (parsed.type === "track" || parsed.type === "episode") return await this.resolveSingleEntity(parsed, options);
            if (["playlist", "album", "show"].includes(parsed.type)) return await this.resolveCollection(parsed, options);
            throw new SpotifyResolverError(`Unsupported entity type: ${parsed.type}`, "UNSUPPORTED_TYPE");
        });
    }

    private extractValidStreamUrl(ytTrack: TrackMetadata): string {
        return ytTrack?.source === "youtube" && ytTrack.canonicalUrl.startsWith("https://www.youtube.com/watch?v=")
            ? ytTrack.canonicalUrl : "";
    }

    public async resolveTrackOnDemand(track: SpotifyMetadata | TrackMetadata, options: Record<string, unknown> = {}): Promise<TrackMetadata> {
        const signal = options.signal as AbortSignal | undefined;
        const fields = track as unknown as Record<string, unknown>;
        const activeUrl = typeof fields.streamUrl === "string" ? fields.streamUrl : "";
        const isDirectAudioUrl = activeUrl.includes("googlevideo.com") || activeUrl.includes("/videoplayback");

        if (fields.isLazy === false && isDirectAudioUrl && !isStreamUrlExpired(activeUrl)) return track as TrackMetadata;
        if (isDirectAudioUrl && isStreamUrlExpired(activeUrl)) this.logger.info(`Stream URL expired for "${fields.title}". Re-resolving JIT stream...`);

        const title = typeof fields.title === "string" ? fields.title : "";
        const artist = typeof fields.author === "string" ? fields.author : typeof fields.artist === "string" ? fields.artist : "";
        let primaryArtist = typeof fields.primaryArtist === "string" && fields.primaryArtist.trim() ? fields.primaryArtist : "";
        let featuredArtists: string[] = Array.isArray(fields.featuredArtists) ? (fields.featuredArtists as unknown[]).map(a => String(a).trim()).filter(Boolean) : [];

        if (!primaryArtist && artist) {
            const parts = artist.split(/,|\s+(?:&|feat\.?|ft\.?|with)\s+/i).map(s => s.trim()).filter(Boolean);
            primaryArtist = parts[0] || "";
            if (!featuredArtists.length && parts.length > 1) featuredArtists = parts.slice(1);
        }

        const durationSec = typeof fields.duration === "number" && Number.isFinite(fields.duration) ? fields.duration : typeof fields.durationSec === "number" && Number.isFinite(fields.durationSec) ? fields.durationSec : 0;
        const thumbnail = typeof fields.thumbnail === "string" ? fields.thumbnail : undefined;
        const spotifyUrl = typeof fields.spotifyUrl === "string" && fields.spotifyUrl ? fields.spotifyUrl : typeof fields.canonicalUrl === "string" ? fields.canonicalUrl : "";

        let meta: SpotifyMetadata = { title, artist, primaryArtist, featuredArtists, durationSec, thumbnail, spotifyUrl, isrc: typeof fields.isrc === "string" ? fields.isrc : undefined, isLive: fields.isLive === true };

        const isInvalidArtist = !meta.primaryArtist || ["unknown artist", "spotify"].includes(meta.primaryArtist.toLowerCase());
        const isInvalidTitle = !meta.title || /^track\s+[a-zA-Z0-9]{15,32}$/i.test(meta.title);

        if (isInvalidArtist || isInvalidTitle) {
            this.logger.warn(`[MetadataGuard] Incomplete track metadata ("${meta.title}" by "${meta.artist}"). Recovering metadata...`);
            if (meta.spotifyUrl) {
                const parsed = this.parseSpotifyUrl(meta.spotifyUrl);
                if (parsed) {
                    try {
                        const recovered = await this.extractMetadata(parsed, signal);
                        if (recovered?.title && recovered.primaryArtist) {
                            this.logger.info(`[MetadataGuard] Recovered metadata: "${recovered.title}" by "${recovered.artist}"`);
                            meta = recovered;
                        }
                    } catch (err) {
                        this.logger.debug("[MetadataGuard] Metadata recovery failed:", err);
                    }
                }
            }
        }

        if (!meta.title || /^track\s+[a-zA-Z0-9]{15,32}$/i.test(meta.title)) {
            throw new SpotifyResolverError(`Failed to extract reliable Spotify metadata for URL: ${meta.spotifyUrl || "N/A"}`, "METADATA_FAILED");
        }

        const ytTrack = await this.searchYouTubeFast(meta, signal);
        let resolvedUrl = this.extractValidStreamUrl(ytTrack);

        this.logger.debug(`[JIT-Resolver] Search matched "${ytTrack.title}" (${ytTrack.duration}s) | Raw URL: ${resolvedUrl}`);

        if (!resolvedUrl) throw new SpotifyResolverError(`Could not resolve a valid stream URL for "${meta.title}"`, "YOUTUBE_NOT_FOUND");

        return {
            source: "spotify",
            sourceId: this.parseSpotifyUrl(meta.spotifyUrl || spotifyUrl)?.id ?? meta.spotifyUrl,
            canonicalUrl: meta.spotifyUrl || spotifyUrl,
            webpageUrl: meta.spotifyUrl || spotifyUrl,
            title: meta.title || ytTrack.title,
            author: meta.artist || ytTrack.author,
            duration: meta.durationSec || ytTrack.duration,
            thumbnail: meta.thumbnail || ytTrack.thumbnail || thumbnail || "",
            requestedBy: typeof fields.requestedBy === "string" ? fields.requestedBy : (typeof options.requestedBy === "string" ? options.requestedBy : undefined),
            requestedById: typeof fields.requestedById === "string" ? fields.requestedById : (typeof options.requestedById === "string" ? options.requestedById : undefined),
            isLive: false,
            engine: ytTrack.engine || "yt-dlp",
            playbackSource: "youtube",
            playbackUrl: resolvedUrl,
            playbackSourceId: ytTrack.sourceId,
            mappingVerified: true,
            spotifyUrl: meta.spotifyUrl || spotifyUrl,
            isrc: meta.isrc,
            isLazy: false,
        };
    }

    public async search(_query: string, _options: Record<string, unknown> = {}): Promise<TrackMetadata[]> { return []; }

    public getCacheStats(): { metadata: CacheStats; search: CacheStats; collection: CacheStats } {
        return { metadata: this.metadataCache.getStats(), search: this.searchCache.getStats(), collection: this.collectionCache.getStats() };
    }

    public destroy(): void {
        this.metadataCache.destroy();
        this.searchCache.destroy();
        this.collectionCache.destroy();
        this.singleflight.clear();
    }

    private async resolveRedirectIfNeeded(url: string, signal?: AbortSignal): Promise<string> {
        if (!SHORT_LINK_REGEX.test(url)) return url;
        try {
            const res = await fetchWithRetry(url, { method: "HEAD", signal, timeoutMs: this.requestTimeoutMs });
            if (res.url && res.url !== url && SPOTIFY_URL_REGEX.test(res.url)) return res.url;
        } catch {}
        return url;
    }

    private parseSpotifyUrl(url: string): ParsedSpotifyUrl | null {
        const match = url.trim().match(SPOTIFY_URL_REGEX);
        if (!match) return null;
        const type = (match[1] || match[3] || "").toLowerCase() as SpotifyEntityType;
        const id = match[2] || match[4];
        return type && id ? { type, id, canonicalUrl: `https://open.spotify.com/${type}/${id}`, rawUrl: url } : null;
    }

    private async resolveSingleEntity(parsed: ParsedSpotifyUrl, options: Record<string, unknown>): Promise<TrackMetadata> {
        const cacheKey = `${parsed.type}:${parsed.id}`;
        let metadata = this.metadataCache.get(cacheKey);
        if (!metadata) {
            metadata = await this.extractMetadata(parsed, options.signal as AbortSignal | undefined);
            this.metadataCache.set(cacheKey, metadata);
        }
        return await this.resolveTrackOnDemand(metadata, options);
    }

    private async resolveCollection(parsed: ParsedSpotifyUrl, options: Record<string, unknown>): Promise<TrackMetadata[]> {
        const cacheKey = `${parsed.type}:${parsed.id}`;
        let collectionTracks = this.collectionCache.get(cacheKey);
        if (!collectionTracks) {
            collectionTracks = await this.extractCollectionTracks(parsed, options);
            if (collectionTracks?.length) this.collectionCache.set(cacheKey, collectionTracks);
        }
        if (!collectionTracks?.length) throw new SpotifyResolverError(`Collection ${parsed.type}/${parsed.id} is empty or unresolvable`, "COLLECTION_EMPTY");

        const limit = this.maxCollectionTracks > 0 ? this.maxCollectionTracks : collectionTracks.length;
        const targetTracks = collectionTracks.length > limit ? collectionTracks.slice(0, limit) : collectionTracks;

        const reqBy = typeof options.requestedBy === "string" ? options.requestedBy : undefined;
        const reqById = typeof options.requestedById === "string" ? options.requestedById : undefined;

        return targetTracks.map(meta => ({
            title: meta.title,
            author: meta.artist,
            source: "spotify",
            sourceId: this.parseSpotifyUrl(meta.spotifyUrl)?.id ?? meta.spotifyUrl,
            canonicalUrl: meta.spotifyUrl,
            webpageUrl: meta.spotifyUrl,
            duration: meta.durationSec,
            thumbnail: meta.thumbnail || "",
            requestedBy: reqBy,
            requestedById: reqById,
            isLive: false,
            engine: "yt-dlp",
            spotifyUrl: meta.spotifyUrl,
            isrc: meta.isrc,
            primaryArtist: meta.primaryArtist,
            featuredArtists: [...meta.featuredArtists],
            isLazy: true,
        }));
    }

    private async extractMetadata(parsed: ParsedSpotifyUrl, signal?: AbortSignal): Promise<SpotifyMetadata> {
        if (this.spotifyApiClient.isAvailable()) {
            try {
                if (parsed.type === "track") {
                    const trackMeta = await this.spotifyApiClient.getTrack(parsed.id, signal);
                    if (trackMeta) return trackMeta;
                } else if (parsed.type === "episode") {
                    const epMeta = await this.spotifyApiClient.getEpisode(parsed.id, signal);
                    if (epMeta) return epMeta;
                }
            } catch (err) {
                this.logger.debug("[ExtractMetadata] Spotify Web API failed:", err);
            }
        }

        // Fast & 100% Reliable Fallback 1: Spotify Embed Scraper (Extracts full track JSON from open.spotify.com/embed/...)
        const embedMeta = await this.fetchEmbedScrapedSingleMetadata(parsed, signal);
        if (embedMeta?.title && embedMeta.primaryArtist) return embedMeta;

        const webMeta = await this.fetchWebScrapedMetadata(parsed.canonicalUrl, signal);
        if (webMeta?.title && webMeta.primaryArtist && webMeta.durationSec > 0) return webMeta;

        const oEmbedMeta = await this.fetchOembedMetadata(parsed.canonicalUrl, signal);
        if (oEmbedMeta?.title && oEmbedMeta.primaryArtist) {
            return {
                title: oEmbedMeta.title,
                artist: oEmbedMeta.artist,
                primaryArtist: oEmbedMeta.primaryArtist,
                featuredArtists: oEmbedMeta.featuredArtists,
                durationSec: webMeta?.durationSec || oEmbedMeta.durationSec,
                thumbnail: webMeta?.thumbnail || oEmbedMeta.thumbnail,
                spotifyUrl: parsed.canonicalUrl,
                album: webMeta?.album,
                releaseYear: webMeta?.releaseYear,
                explicit: webMeta?.explicit,
                isrc: webMeta?.isrc,
                isLive: oEmbedMeta.isLive || webMeta?.isLive,
            };
        }

        if (webMeta?.title && webMeta.primaryArtist) return webMeta;
        if (webMeta?.title) return webMeta;
        if (oEmbedMeta?.title) return oEmbedMeta;

        throw new SpotifyResolverError(`Unable to retrieve metadata for Spotify ${parsed.type} (${parsed.id})`, "METADATA_FAILED");
    }

    private async fetchEmbedScrapedSingleMetadata(parsed: ParsedSpotifyUrl, signal?: AbortSignal): Promise<SpotifyMetadata | null> {
        try {
            const tracks = await this.fetchEmbedScrapedCollectionTracks(parsed, signal);
            if (tracks && tracks.length > 0 && tracks[0].title && tracks[0].primaryArtist) {
                return tracks[0];
            }
        } catch {}
        return null;
    }

    private async fetchEmbedScrapedCollectionTracks(parsed: ParsedSpotifyUrl, signal?: AbortSignal): Promise<SpotifyMetadata[]> {
        const embedUrl = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}`;
        try {
            const res = await fetchWithRetry(embedUrl, { signal, timeoutMs: this.requestTimeoutMs, maxRetries: 1 });
            const html = await res.text();

            const scriptMatch = html.match(/<script id=["'](?:initial-state|__NEXT_DATA__|resource)["'][^>]*>([^<]+)<\/script>/i);
            if (!scriptMatch?.[1]) return [];

            let jsonStr = scriptMatch[1].trim();
            if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
                try {
                    jsonStr = typeof globalThis.atob === "function" ? globalThis.atob(jsonStr) : Buffer.from(jsonStr, "base64").toString("utf-8");
                } catch {}
            }

            const data = JSON.parse(jsonStr);
            const entity = data?.props?.pageProps?.state?.data?.entity || data?.entity;
            const trackList = entity?.trackList || entity?.tracks?.items || data?.tracks || [];

            if (!Array.isArray(trackList) || trackList.length === 0) {
                if (entity && (entity.title || entity.name)) {
                    const title = decodeHtmlEntities(entity.title || entity.name || "");
                    const rawSubtitle = entity.subtitle ||
                        (Array.isArray(entity.artists) ? entity.artists.map((a: any) => a.name).join(", ") : "") ||
                        (Array.isArray(entity.artistsV2) ? entity.artistsV2.map((a: any) => a.name || a.profile?.name).join(", ") : "");

                    const subtitle = decodeHtmlEntities(typeof rawSubtitle === "string" ? rawSubtitle.trim() : "");
                    const splitArtists = subtitle.split(/,|\s+(?:&|feat\.?|ft\.?|with|and)\s+/i).map(s => s.trim()).filter(Boolean);
                    const primaryArtist = splitArtists[0] || "";
                    const featuredArtists = splitArtists.slice(1);
                    const durationMs = entity.duration || entity.duration_ms || 0;
                    const durationSec = Math.floor(Number(durationMs) / 1000) || 0;

                    if (title && primaryArtist) {
                        return [{
                            title,
                            artist: subtitle,
                            primaryArtist,
                            featuredArtists,
                            durationSec,
                            thumbnail: extractImageUrl(entity.images) || extractImageUrl(entity.relatedEntityCoverArt) || extractImageUrl(entity.album?.images),
                            spotifyUrl: parsed.canonicalUrl,
                            isLive: false,
                        }];
                    }
                }
                return [];
            }

            const results: SpotifyMetadata[] = [];
            for (const item of trackList) {
                if (!item || typeof item !== "object") continue;
                const uri = (item as any).uri || (item as any).track?.uri || "";
                const uriMatch = typeof uri === "string" ? uri.match(/spotify:(track|episode):([a-zA-Z0-9]{15,32})/) : null;
                const itemType = uriMatch?.[1] || "track";
                const itemId = uriMatch?.[2] || (item as any).id || "";

                const rawTitle = (item as any).title || (item as any).name || (item as any).track?.name || "";
                const title = decodeHtmlEntities(typeof rawTitle === "string" ? rawTitle.trim() : "");
                if (!title) continue;

                const rawSubtitle = (item as any).subtitle ||
                    (Array.isArray((item as any).artists) ? (item as any).artists.map((a: any) => a.name).join(", ") : "") ||
                    (Array.isArray((item as any).track?.artists) ? (item as any).track.artists.map((a: any) => a.name).join(", ") : "");

                const subtitle = decodeHtmlEntities(typeof rawSubtitle === "string" ? rawSubtitle.trim() : "");
                const splitArtists = subtitle.split(/,|\s+(?:&|feat\.?|ft\.?|with|and)\s+/i).map(s => s.trim()).filter(Boolean);
                const primaryArtist = splitArtists[0] || "";
                const featuredArtists = splitArtists.slice(1);

                const durationMs = (item as any).duration || (item as any).duration_ms || (item as any).track?.duration_ms || 0;
                const durationSec = Math.floor(Number(durationMs) / 1000) || 0;

                const spotifyUrl = itemId ? `https://open.spotify.com/${itemType}/${itemId}` : parsed.canonicalUrl;

                results.push({
                    title,
                    artist: subtitle || "Unknown Artist",
                    primaryArtist,
                    featuredArtists,
                    durationSec,
                    spotifyUrl,
                    isLive: false,
                });
            }

            return results;
        } catch (err) {
            this.logger.debug("[FetchEmbedScrapedCollectionTracks] Embed parsing failed:", err);
            return [];
        }
    }

    private async extractCollectionTracks(parsed: ParsedSpotifyUrl, options: Record<string, unknown>): Promise<SpotifyMetadata[]> {
        const signal = options.signal as AbortSignal | undefined;
        if (this.spotifyApiClient.isAvailable()) {
            try {
                let tracks: SpotifyMetadata[] | null = null;
                if (parsed.type === "playlist") tracks = await this.spotifyApiClient.getPlaylistItems(parsed.id, this.maxCollectionTracks, signal);
                else if (parsed.type === "album") tracks = await this.spotifyApiClient.getAlbumItems(parsed.id, this.maxCollectionTracks, signal);
                else if (parsed.type === "show") tracks = await this.spotifyApiClient.getShowItems(parsed.id, this.maxCollectionTracks, signal);
                if (tracks?.length) return tracks;
            } catch {}
        }

        // Fast fallback 1: Embed scraper (Hoạt động cho 100% Spotify public playlists/albums/shows không cần API key)
        const embedTracks = await this.fetchEmbedScrapedCollectionTracks(parsed, signal);
        if (embedTracks && embedTracks.length > 0) {
            this.logger.info(`[SpotifyResolver] Successfully extracted ${embedTracks.length} tracks from Spotify embed for ${parsed.type}/${parsed.id}`);
            return embedTracks;
        }

        try {
            const providerResults = this.searchProvider ? await this.searchProvider.search(parsed.canonicalUrl, { ...options, flat: true }) : [];
            if (Array.isArray(providerResults) && providerResults.length > 0) {
                return providerResults.map(item => {
                    const extracted = extractArtistsFromSpotifyObject(item as unknown as Record<string, unknown>);
                    const author = extracted.length ? extracted.join(", ") : (item.author || "");
                    const primary = extracted.length ? extracted[0] : author.split(/,|\s+(?:&|feat\.?|ft\.?|with)\s+/i)[0].trim();

                    // Xây dựng URL riêng cho mỗi track thay vì dùng URL playlist/album
                    let trackSpotifyUrl = "";
                    const itemAny = item as unknown as Record<string, unknown>;
                    if (typeof itemAny.spotifyUrl === "string" && itemAny.spotifyUrl) {
                        trackSpotifyUrl = itemAny.spotifyUrl;
                    } else if (typeof itemAny.external_urls === "object" && itemAny.external_urls && typeof (itemAny.external_urls as any).spotify === "string") {
                        trackSpotifyUrl = (itemAny.external_urls as any).spotify;
                    } else if (typeof itemAny.id === "string" && itemAny.id) {
                        trackSpotifyUrl = `https://open.spotify.com/track/${itemAny.id}`;
                    } else if (item.canonicalUrl.includes("spotify.com/track/")) {
                        trackSpotifyUrl = item.canonicalUrl;
                    } else {
                        // Fallback cuối: dùng URL gốc, track sẽ được resolve lại qua metadata
                        trackSpotifyUrl = parsed.canonicalUrl;
                    }

                    return {
                        title: decodeHtmlEntities(item.title),
                        artist: author,
                        primaryArtist: primary,
                        featuredArtists: extracted.slice(1),
                        durationSec: item.duration || 0,
                        thumbnail: item.thumbnail,
                        spotifyUrl: trackSpotifyUrl,
                        isLive: item.isLive ?? false,
                    };
                });
            }
        } catch {}

        const webMeta = await this.fetchWebScrapedMetadata(parsed.canonicalUrl, signal);
        if (webMeta?.title) return [webMeta];

        const oEmbedMeta = await this.fetchOembedMetadata(parsed.canonicalUrl, signal);
        if (oEmbedMeta?.title) return [oEmbedMeta];

        return [];
    }

    private async fetchOembedMetadata(canonicalUrl: string, signal?: AbortSignal): Promise<SpotifyMetadata | null> {
        try {
            const res = await fetchWithRetry(`https://open.spotify.com/oembed?url=${encodeURIComponent(canonicalUrl)}`, { signal, timeoutMs: this.requestTimeoutMs, maxRetries: 1 });
            const json = (await res.json()) as Record<string, unknown>;
            const parsed = parseOembedArtistAndTitle(json);
            if (!parsed.title) return null;

            this.logger.debug(`[oEmbedParser] Parsed oEmbed Title: "${parsed.title}" | Artist: "${parsed.artist}" | Primary: "${parsed.primaryArtist}"`);
            return {
                title: parsed.title,
                artist: parsed.artist,
                primaryArtist: parsed.primaryArtist,
                featuredArtists: parsed.featuredArtists,
                durationSec: 0,
                thumbnail: typeof json.thumbnail_url === "string" ? json.thumbnail_url : undefined,
                spotifyUrl: canonicalUrl,
                isLive: detectVariantFlags(parsed.title).isLive,
            };
        } catch {
            return null;
        }
    }

    private extractEmbeddedJsonMetadata(html: string, canonicalUrl: string): SpotifyMetadata | null {
        if (!html) return null;
        const scriptRegex = /<script\s+id=["'](?:initial-state|__NEXT_DATA__|session|config)["'][^>]*>([^<]+)<\/script>/gi;
        let match: RegExpExecArray | null;

        while ((match = scriptRegex.exec(html)) !== null) {
            const content = match[1]?.trim();
            if (!content) continue;

            let jsonStr = content;
            if (!content.startsWith("{") && !content.startsWith("[")) {
                try {
                    jsonStr = typeof globalThis.atob === "function" ? globalThis.atob(content) : Buffer.from(content, "base64").toString("utf-8");
                } catch {}
            }

            try {
                const data = JSON.parse(jsonStr);
                const foundTrack = findTrackEntityInObject(data);
                if (foundTrack) {
                    const parsed = parseSpotifyTrackObject(foundTrack, undefined, undefined, this.logger);
                    if (parsed?.title && parsed.primaryArtist) {
                        return { ...parsed, spotifyUrl: canonicalUrl };
                    }
                }
            } catch {}
        }
        return null;
    }

    private async fetchWebScrapedMetadata(canonicalUrl: string, signal?: AbortSignal): Promise<SpotifyMetadata | null> {
        try {
            const res = await fetchWithRetry(canonicalUrl, { signal, timeoutMs: this.requestTimeoutMs, maxRetries: 1 });
            const html = await res.text();

            const embeddedMeta = this.extractEmbeddedJsonMetadata(html, canonicalUrl);
            if (embeddedMeta?.title && embeddedMeta.primaryArtist && embeddedMeta.durationSec > 0) return embeddedMeta;

            const jsonLdMatch = html.match(/<script\s+type=["']application\/ld\+json["']\s*>([^<]+)<\/script>/gi);
            if (jsonLdMatch) {
                for (const tag of jsonLdMatch) {
                    const content = tag.replace(/<script\s+type=["']application\/ld\+json["']\s*>/i, "").replace(/<\/script>/i, "").trim();
                    if (!content) continue;
                    try {
                        const ld = JSON.parse(content);
                        const items = Array.isArray(ld) ? ld : [ld];
                        for (const item of items) {
                            const ldTitle = typeof item.name === "string" ? decodeHtmlEntities(item.name.trim()) : "";
                            const ldArtists: string[] = [];
                            if (Array.isArray(item.byArtist)) {
                                item.byArtist.forEach((a: any) => {
                                    if (typeof a?.name === "string") ldArtists.push(decodeHtmlEntities(a.name.trim()));
                                });
                            } else if (typeof item.byArtist?.name === "string") {
                                ldArtists.push(decodeHtmlEntities(item.byArtist.name.trim()));
                            }

                            const durationSec = typeof item.duration === "string" ? parseIsoDuration(item.duration) : 0;
                            const albumName = typeof item.inAlbum?.name === "string" ? decodeHtmlEntities(item.inAlbum.name.trim()) : undefined;
                            const releaseDate = typeof item.datePublished === "string" ? item.datePublished : typeof item.uploadDate === "string" ? item.uploadDate : undefined;
                            const releaseYear = releaseDate ? (y => isNaN(y) ? undefined : y)(parseInt(releaseDate.slice(0, 4), 10)) : undefined;

                            if (ldTitle && ldArtists.length) {
                                const primaryArtist = ldArtists[0];
                                const artist = ldArtists.join(", ");
                                const featuredArtists = ldArtists.slice(1);
                                const thumbnail = typeof item.image === "string" ? item.image : (Array.isArray(item.image) ? item.image[0] : undefined);
                                return {
                                    title: ldTitle,
                                    artist,
                                    primaryArtist,
                                    featuredArtists,
                                    durationSec,
                                    thumbnail,
                                    spotifyUrl: canonicalUrl,
                                    album: albumName,
                                    releaseYear,
                                    isLive: detectVariantFlags(ldTitle).isLive,
                                };
                            }
                        }
                    } catch {}
                }
            }

            const ogTitleMatch = html.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i);
            const ogDescMatch = html.match(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i);
            const ogImageMatch = html.match(/<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i);
            const durMatch = html.match(/<meta\s+(?:property|name)=["']music:duration["']\s+content=["']([^"']+)["']/i);
            const releaseMatch = html.match(/<meta\s+(?:property|name)=["']music:release_date["']\s+content=["']([^"']+)["']/i);

            if (!ogTitleMatch?.[1]) return null;

            let rawTitle = decodeHtmlEntities(ogTitleMatch[1].trim().replace(/\s*\|\s*Spotify\s*$/i, "").trim());
            const rawDesc = ogDescMatch ? decodeHtmlEntities(ogDescMatch[1].trim()) : "";
            let extractedTitle = rawTitle;
            let extractedArtists: string[] = [];

            const splitArtists = (s: string) => s.split(/,|\s+(?:&|feat\.?|ft\.?|with|and|x)\s+/i).map(s => s.trim()).filter(Boolean);

            const byMatch = rawTitle.match(/^(.*?)\s*[-–—]\s*(?:song|episode|podcast|track)?(?:\s*and lyrics)?\s*by\s*(.*?)$/i) || rawTitle.match(/^(.*?)\s+by\s+(.*?)$/i);
            if (byMatch) {
                extractedTitle = byMatch[1].trim();
                extractedArtists = splitArtists(byMatch[2].trim());
            }

            if (!extractedArtists.length && rawDesc) {
                const parts = rawDesc.split("·").map(p => p.trim());
                if (parts.length >= 2) {
                    const artistPart = parts[0].replace(/^Listen to .*? on Spotify\.\s*/i, "").trim();
                    if (artistPart && artistPart.toLowerCase() !== "spotify") {
                        extractedArtists = splitArtists(artistPart);
                    }
                }
            }

            if (!extractedTitle) return null;

            const primaryArtist = extractedArtists[0] || "";
            const artist = extractedArtists.join(", ");
            const featuredArtists = extractedArtists.slice(1);
            const flags = detectVariantFlags(extractedTitle);
            const durationSec = durMatch?.[1] ? parseInt(durMatch[1], 10) || 0 : 0;
            const releaseYear = releaseMatch?.[1] ? parseInt(releaseMatch[1].slice(0, 4), 10) || undefined : undefined;

            this.logger.debug(`[WebScraper] Scraped Title: "${extractedTitle}" | Artist: "${artist}" | Duration: ${durationSec}s`);
            return {
                title: extractedTitle,
                artist,
                primaryArtist,
                featuredArtists,
                durationSec,
                thumbnail: ogImageMatch ? ogImageMatch[1].trim() : undefined,
                spotifyUrl: canonicalUrl,
                releaseYear,
                isLive: flags.isLive
            };
        } catch (err) {
            this.logger.debug("[WebScraper] Web scraping failed:", err);
            return null;
        }
    }

    private async searchYouTubeFast(meta: SpotifyMetadata, signal?: AbortSignal): Promise<TrackMetadata> {
        this.logger.info(`[YouTubeSearch] Searching for "${meta.title}" by "${meta.artist}" (ISRC: ${meta.isrc || "N/A"}, Duration: ${meta.durationSec}s)`);

        const queries = generateSearchQueries(meta);
        const candidateMap = new Map<string, TrackMetadata>();

        for (const query of queries) {
            if (signal?.aborted) break;
            this.logger.debug(`[YouTubeSearch] Executing query: "${query}"`);
            const results = await this.executeSearch(query, signal);
            if (!results || !results.length) continue;

            for (const item of results) {
                const streamUrl = this.extractValidStreamUrl(item);
                if (!streamUrl) continue;

                const candidateId = extractCandidateId(item, streamUrl);
                if (!candidateMap.has(candidateId)) {
                    candidateMap.set(candidateId, item);
                }
            }
        }

        const uniqueCandidates = Array.from(candidateMap.values());
        if (!uniqueCandidates.length) {
            this.logger.warn(`[YouTubeSearch] Zero candidate results returned across ${queries.length} queries for "${meta.title}" by "${meta.artist}"`);
            throw new SpotifyResolverError(
                `No high-confidence YouTube stream match found for "${meta.title}" by "${meta.artist}" (0 candidates found)`,
                "YOUTUBE_NOT_FOUND"
            );
        }

        let bestCandidate: TrackMetadata | null = null;
        let bestScore = -1;
        let bestBreakdown = "";
        let bestPassesMandatory = false;

        for (const candidate of uniqueCandidates) {
            if (signal?.aborted) break;

            const streamUrl = this.extractValidStreamUrl(candidate);
            const candidateId = extractCandidateId(candidate, streamUrl);
            const candTitle = candidate.title || "";
            const candAuthor = candidate.author || (candidate as any).channel || (candidate as any).uploader || "Unknown";
            const candChannel = String((candidate as any).channel || (candidate as any).uploader || candAuthor);

            if (!isValidCandidate(candidate, meta, this.logger)) {
                this.logger.debug(`[YouTubeSearch] Candidate [ID: ${candidateId}] "${candTitle}" by "${candAuthor}" HARD REJECTED by candidate filter`);
                continue;
            }

            const { score, breakdown, passesMandatory, reason } = scoreCandidate(candidate, meta, this.logger);

            const decision = score >= 70 && passesMandatory ? "ACCEPTED" : "REJECTED";
            this.logger.info(
                `[YouTubeSearch] Evaluated Candidate [ID: ${candidateId}] "${candTitle}" by "${candAuthor}" | Channel: "${candChannel}" | Duration: ${candidate.duration}s | Score: ${score} | Breakdown: ${breakdown} | Decision: ${decision} (${reason})`
            );

            if (score >= 90 && passesMandatory) {
                this.logger.info(`[YouTubeSearch] High-confidence match selected: "${candTitle}" (${candidate.canonicalUrl}) | Score: ${score}`);
                return candidate;
            }

            if (passesMandatory && score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
                bestBreakdown = breakdown;
                bestPassesMandatory = passesMandatory;
            }
        }

        const minAcceptScore = 70;
        if (bestCandidate && bestScore >= minAcceptScore && bestPassesMandatory) {
            this.logger.info(`[YouTubeSearch] Acceptable match selected: "${bestCandidate.title}" (${bestCandidate.canonicalUrl}) | Score: ${bestScore} | ${bestBreakdown}`);
            return bestCandidate;
        }

        this.logger.warn(
            `[YouTubeSearch] Failed to find reliable YouTube match for "${meta.title}" by "${meta.artist}". Best score was ${bestScore >= 0 ? bestScore : "none"}. Throwing YOUTUBE_NOT_FOUND.`
        );

        throw new SpotifyResolverError(
            `No high-confidence YouTube stream match found for "${meta.title}" by "${meta.artist}" (Best score: ${bestScore >= 0 ? bestScore : "none"})`,
            "YOUTUBE_NOT_FOUND"
        );
    }

    private async executeSearch(query: string, signal?: AbortSignal): Promise<TrackMetadata[]> {
        const cacheKey = query.toLowerCase().trim();
        const cached = this.searchCache.get(cacheKey);
        if (cached) return cached;

        try {
            return await this.singleflight.do(`search:${cacheKey}`, 5000, async (sfSignal) => {
                if (signal?.aborted || sfSignal?.aborted) return [];
                try {
                    const results = this.searchProvider ? await this.searchProvider.search(query, { limit: 8 }) : [];
                    const valid = Array.isArray(results) ? results : [];
                    if (valid.length > 0) this.searchCache.set(cacheKey, valid);
                    return valid;
                } catch {
                    return [];
                }
            });
        } catch {
            return [];
        }
    }
}
