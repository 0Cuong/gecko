import { request, Agent } from "undici";
import type { TrackMetadata } from "./resolver.js";
import { LRUCache } from "../utils/cache.js";

/**
 * Shared HTTP Agent with Keep-Alive & Connection Pooling
 */
const httpAgent = new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connections: 64,
    pipelining: 1,
});

/**
 * Cache & Singleflight Storage Interfaces
 */
interface CacheEntry<T> {
    readonly data: T;
    readonly expiresAt: number;
}

const positiveVideoCache = new LRUCache<string, CacheEntry<TrackMetadata>>({ maxSize: 1000, ttlMs: 30 * 60 * 1000 });
const negativeVideoCache = new LRUCache<string, CacheEntry<null>>({ maxSize: 1000, ttlMs: 3 * 60 * 1000 });

const positiveSearchCache = new LRUCache<string, CacheEntry<TrackMetadata[]>>({ maxSize: 500, ttlMs: 15 * 60 * 1000 });
const negativeSearchCache = new LRUCache<string, CacheEntry<TrackMetadata[]>>({ maxSize: 500, ttlMs: 2 * 60 * 1000 });

/**
 * Singleflight Request Coalescing to Eliminate Duplicate Network Inflight Requests
 */
class Singleflight<T> {
    private inflight = new Map<string, Promise<T>>();

    public async do(key: string, fn: () => Promise<T>): Promise<T> {
        const existing = this.inflight.get(key);
        if (existing) {
            return existing;
        }

        const promise = (async () => {
            try {
                return await fn();
            } finally {
                this.inflight.delete(key);
            }
        })();

        this.inflight.set(key, promise);
        return promise;
    }
}

const videoSingleflight = new Singleflight<TrackMetadata | null>();
const searchSingleflight = new Singleflight<TrackMetadata[]>();

/**
 * InnerTube Client Presets with Priority Fallback Sequence
 */
interface InnerTubeClientConfig {
    readonly name: string;
    readonly clientName: string;
    readonly clientVersion: string;
    readonly headerId: string;
    readonly userAgent: string;
    readonly hl: string;
    readonly gl: string;
    readonly androidSdkVersion?: number;
    readonly deviceModel?: string;
    readonly osName?: string;
    readonly osVersion?: string;
}

const CLIENT_PRESETS: readonly InnerTubeClientConfig[] = Object.freeze([
    {
        name: "WEB",
        clientName: "WEB",
        clientVersion: "2.20240215.00.00",
        headerId: "1",
        hl: "en",
        gl: "US",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    },
    {
        name: "ANDROID",
        clientName: "ANDROID",
        clientVersion: "19.05.36",
        headerId: "3",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
        userAgent: "com.google.android.youtube/19.05.36 (Linux; U; Android 11; US) gzip"
    },
    {
        name: "ANDROID_MUSIC",
        clientName: "ANDROID_MUSIC",
        clientVersion: "6.41.52",
        headerId: "21",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
        userAgent: "com.google.android.apps.youtube.music/6.41.52 (Linux; U; Android 11; US) gzip"
    },
    {
        name: "MWEB",
        clientName: "MWEB",
        clientVersion: "2.20240215.00.00",
        headerId: "2",
        hl: "en",
        gl: "US",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"
    },
    {
        name: "TVHTML5",
        clientName: "TVHTML5",
        clientVersion: "7.20240215.00.00",
        headerId: "7",
        hl: "en",
        gl: "US",
        userAgent: "Mozilla/5.0 (SmartHub; SMART-TV; U; Linux/SmartTV; Maple2012) AppleWebKit/534.7 (KHTML, like Gecko) SmartTV Safari/534.7"
    },
    {
        name: "IOS",
        clientName: "IOS",
        clientVersion: "19.05.2",
        headerId: "5",
        deviceModel: "iPhone14,3",
        osName: "iOS",
        osVersion: "17.2.0.21C62",
        hl: "en",
        gl: "US",
        userAgent: "com.google.ios.youtube/19.05.2 (iPhone14,3; U; CPU iOS 17_2 like Mac OS X; en_US)"
    }
]);

/**
 * Universal Text Extraction Helper (Handles `simpleText`, `runs`, `label`, `text`, primitives)
 */
function extractText(obj: unknown): string {
    if (obj === null || obj === undefined) return "";
    if (typeof obj === "string") return obj.trim();
    if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
    if (typeof obj !== "object") return "";

    const o = obj as Record<string, any>;
    if (typeof o.simpleText === "string" && o.simpleText.trim()) {
        return o.simpleText.trim();
    }
    if (typeof o.label === "string" && o.label.trim()) {
        return o.label.trim();
    }
    if (typeof o.text === "string" && o.text.trim()) {
        return o.text.trim();
    }
    if (Array.isArray(o.runs)) {
        let res = "";
        for (let i = 0; i < o.runs.length; i++) {
            const run = o.runs[i];
            if (run && typeof run.text === "string") {
                res += run.text;
            }
        }
        if (res.trim()) return res.trim();
    }
    return "";
}

/**
 * Fault-Tolerant Duration Parser (Supports Seconds, MM:SS, HH:MM:SS, ISO 8601, LIVE strings)
 */
function parseDuration(raw: unknown): number {
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === "number") return Math.max(0, Math.floor(raw));

    const str = String(raw).trim();
    if (!str) return 0;

    const upper = str.toUpperCase();
    if (upper === "LIVE" || upper === "UPCOMING" || upper === "PREMIERE") return 0;

    if (/^\d+$/.test(str)) {
        return parseInt(str, 10);
    }

    const isoMatch = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(str);
    if (isoMatch) {
        const h = parseInt(isoMatch[1] || "0", 10);
        const m = parseInt(isoMatch[2] || "0", 10);
        const s = parseInt(isoMatch[3] || "0", 10);
        return h * 3600 + m * 60 + s;
    }

    const parts = str.split(":");
    let total = 0;
    let multiplier = 1;
    for (let i = parts.length - 1; i >= 0; i--) {
        const val = parseInt(parts[i].replace(/\D/g, ""), 10);
        if (!Number.isNaN(val)) {
            total += val * multiplier;
            multiplier *= 60;
        } else {
            return 0;
        }
    }
    return total;
}

/**
 * Highest-Quality Thumbnail Selection (Zero array mutation)
 */
function selectThumbnail(thumbnailObj: unknown, videoId: string): string {
    const fallback = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
    if (!thumbnailObj || typeof thumbnailObj !== "object") return fallback;

    const thumbnails = (thumbnailObj as Record<string, any>).thumbnails;
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return fallback;

    let bestUrl = "";
    let bestSize = -1;

    for (let i = 0; i < thumbnails.length; i++) {
        const item = thumbnails[i];
        if (!item || typeof item !== "object") continue;
        const url = item.url;
        if (typeof url !== "string" || !url) continue;

        const w = typeof item.width === "number" ? item.width : 0;
        const h = typeof item.height === "number" ? item.height : 0;
        const size = w * h;

        if (size > bestSize || (size === bestSize && !bestUrl)) {
            bestSize = size;
            bestUrl = url;
        }
    }

    if (!bestUrl) bestUrl = fallback;
    if (bestUrl.startsWith("//")) {
        bestUrl = `https:${bestUrl}`;
    }
    return bestUrl;
}

/**
 * Metadata Validation & Sanitization
 */
function sanitizeTrackMetadata(raw: Partial<TrackMetadata> & { sourceId?: string; canonicalUrl?: string; webpageUrl?: string }): TrackMetadata | null {
    if (!raw) return null;

    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;

    const sourceId = typeof raw.sourceId === "string" && raw.sourceId.trim() ? raw.sourceId.trim() : "";
    const canonicalUrl = typeof raw.canonicalUrl === "string" && raw.canonicalUrl.trim() ? raw.canonicalUrl.trim() : "";
    if (!sourceId || !canonicalUrl) return null;

    const author = typeof raw.author === "string" && raw.author.trim() ? raw.author.trim() : "Unknown Artist";
    const duration = typeof raw.duration === "number" && !Number.isNaN(raw.duration) && raw.duration >= 0 ? raw.duration : 0;
    const thumbnail = typeof raw.thumbnail === "string" && raw.thumbnail.trim() ? raw.thumbnail.trim() : "";
    const isLive = Boolean(raw.isLive);

    return {
        title,
        author,
        source: "youtube",
        sourceId,
        canonicalUrl,
        webpageUrl: typeof raw.webpageUrl === "string" && raw.webpageUrl.trim() ? raw.webpageUrl.trim() : canonicalUrl,
        duration,
        thumbnail,
        isLive,
        engine: "InnerTube"
    };
}

/**
 * Search Query Normalization (Unicode NFC, whitespace collapsing)
 */
function normalizeSearchQuery(query: string): string {
    if (!query) return "";
    return query
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/**
 * Resilient Multi-Client InnerTube API HTTP Dispatcher
 */
async function postInnerTubeApi(
    endpoint: string,
    payloadBuilder: (config: InnerTubeClientConfig) => Record<string, any>
): Promise<any | null> {
    for (let clientIdx = 0; clientIdx < CLIENT_PRESETS.length; clientIdx++) {
        const config = CLIENT_PRESETS[clientIdx];
        const clientContext: Record<string, any> = {
            clientName: config.clientName,
            clientVersion: config.clientVersion,
            hl: config.hl,
            gl: config.gl
        };
        if (config.androidSdkVersion) clientContext.androidSdkVersion = config.androidSdkVersion;
        if (config.deviceModel) clientContext.deviceModel = config.deviceModel;
        if (config.osName) clientContext.osName = config.osName;
        if (config.osVersion) clientContext.osVersion = config.osVersion;

        const bodyPayload = JSON.stringify({
            context: { client: clientContext },
            ...payloadBuilder(config)
        });

        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
                const backoff = Math.floor(Math.random() * Math.min(800, 100 * Math.pow(2, attempt)));
                await new Promise((r) => setTimeout(r, backoff));
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);

            try {
                const { statusCode, body } = await request(`https://www.youtube.com/youtubei/v1/${endpoint}`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "User-Agent": config.userAgent,
                        "Accept-Language": "en-US,en;q=0.9",
                        "X-YouTube-Client-Name": config.headerId,
                        "X-YouTube-Client-Version": config.clientVersion
                    },
                    body: bodyPayload,
                    dispatcher: httpAgent,
                    signal: controller.signal,
                    headersTimeout: 5000,
                    bodyTimeout: 5000,
                });

                clearTimeout(timeoutId);

                if (statusCode !== 200) {
                    await body.dump().catch(() => {});
                    if (statusCode === 429 || statusCode >= 500) {
                        continue; // Transient network error -> retry
                    }
                    break; // Non-transient status -> fallback to next client preset
                }

                const jsonResult = await body.json();
                if (jsonResult && typeof jsonResult === "object") {
                    return jsonResult;
                }
            } catch {
                clearTimeout(timeoutId);
            }
        }
    }
    return null;
}

/**
 * Fetch Video Details by Video ID via InnerTube
 */
export async function fetchInnerTubeVideo(videoId: string): Promise<TrackMetadata | null> {
    if (!videoId || typeof videoId !== "string") return null;

    const cleanVideoId = videoId.replace(/[^a-zA-Z0-9_-]/g, "").trim();
    if (!cleanVideoId) return null;

    // Check positive cache
    const cachedPositive = positiveVideoCache.get(cleanVideoId);
    if (cachedPositive && Date.now() < cachedPositive.expiresAt) {
        return cachedPositive.data;
    }

    // Check negative cache
    const cachedNegative = negativeVideoCache.get(cleanVideoId);
    if (cachedNegative && Date.now() < cachedNegative.expiresAt) {
        return null;
    }

    return videoSingleflight.do(cleanVideoId, async () => {
        try {
            const data = await postInnerTubeApi("player", () => ({ videoId: cleanVideoId }));
            if (!data || typeof data !== "object") {
                negativeVideoCache.set(cleanVideoId, { data: null, expiresAt: Date.now() + 3 * 60 * 1000 });
                return null;
            }

            const details = data.videoDetails || {};
            const microformat = data.microformat?.playerMicroformatRenderer || {};

            const title = details.title || extractText(microformat.title);
            if (!title) {
                negativeVideoCache.set(cleanVideoId, { data: null, expiresAt: Date.now() + 3 * 60 * 1000 });
                return null;
            }

            const author = details.author || extractText(microformat.ownerChannelName) || "Unknown Artist";
            const duration = parseDuration(details.lengthSeconds || microformat.lengthSeconds);
            const thumbnail = selectThumbnail(details.thumbnail || microformat.thumbnail, cleanVideoId);
            const isLive = Boolean(details.isLiveContent || details.isLive || microformat.isLiveContent || microformat.liveBroadcastDetails);

            const result = sanitizeTrackMetadata({
                title,
                author,
                sourceId: cleanVideoId,
                canonicalUrl: `https://www.youtube.com/watch?v=${cleanVideoId}`,
                webpageUrl: `https://www.youtube.com/watch?v=${cleanVideoId}`,
                duration,
                thumbnail,
                isLive
            });

            if (result) {
                positiveVideoCache.set(cleanVideoId, { data: result, expiresAt: Date.now() + 30 * 60 * 1000 });
                return result;
            } else {
                negativeVideoCache.set(cleanVideoId, { data: null, expiresAt: Date.now() + 3 * 60 * 1000 });
                return null;
            }
        } catch {
            return null;
        }
    });
}

/**
 * Deep Traverser for InnerTube Search Renderers
 */
function extractSearchRenderers(data: any): Array<{ type: string; data: any }> {
    const renderers: Array<{ type: string; data: any }> = [];

    function traverse(obj: any, depth = 0): void {
        if (depth > 12 || !obj) return;

        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                traverse(obj[i], depth + 1);
            }
            return;
        }

        if (typeof obj !== "object") return;

        if (obj.videoRenderer) {
            renderers.push({ type: "videoRenderer", data: obj.videoRenderer });
            return;
        }
        if (obj.compactVideoRenderer) {
            renderers.push({ type: "compactVideoRenderer", data: obj.compactVideoRenderer });
            return;
        }
        if (obj.playlistVideoRenderer) {
            renderers.push({ type: "playlistVideoRenderer", data: obj.playlistVideoRenderer });
            return;
        }
        if (obj.reelItemRenderer) {
            renderers.push({ type: "reelItemRenderer", data: obj.reelItemRenderer });
            return;
        }
        if (obj.musicResponsiveListItemRenderer) {
            renderers.push({ type: "musicResponsiveListItemRenderer", data: obj.musicResponsiveListItemRenderer });
            return;
        }

        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (
                key === "contents" || key === "items" || key === "sectionListRenderer" ||
                key === "itemSectionRenderer" || key === "primaryContents" ||
                key === "twoColumnSearchResultsRenderer" || key === "singleColumnSearchResultsRenderer" ||
                key === "tabs" || key === "tabRenderer" || key === "content"
            ) {
                traverse(obj[key], depth + 1);
            }
        }
    }

    traverse(data);
    return renderers;
}

/**
 * Universal Search Renderer Parser
 */
function parseSearchItem(item: { type: string; data: any }): TrackMetadata | null {
    const v = item.data;
    if (!v || typeof v !== "object") return null;

    let videoId: string | undefined = v.videoId;
    if (!videoId) videoId = v.playlistItemData?.videoId;
    if (!videoId) videoId = v.navigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId) videoId = v.navigationEndpoint?.reelWatchEndpoint?.videoId;

    if (!videoId || typeof videoId !== "string") return null;
    videoId = videoId.trim();
    if (!videoId) return null;

    let title = extractText(v.title);
    if (!title) title = extractText(v.headline);
    if (!title && Array.isArray(v.flexColumns) && v.flexColumns.length > 0) {
        title = extractText(v.flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
    }
    if (!title) return null;

    let author = extractText(v.ownerText);
    if (!author) author = extractText(v.longBylineText);
    if (!author) author = extractText(v.shortBylineText);
    if (!author) author = extractText(v.channelTitle);
    if (!author && Array.isArray(v.flexColumns) && v.flexColumns.length > 1) {
        author = extractText(v.flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text);
    }
    if (!author) author = "Unknown Artist";

    const lengthStr = extractText(v.lengthText) || String(v.lengthSeconds || "");
    const duration = parseDuration(lengthStr);

    let isLive = false;
    if (Array.isArray(v.badges)) {
        for (let i = 0; i < v.badges.length; i++) {
            const badge = v.badges[i]?.metadataBadgeRenderer || v.badges[i]?.liveBadgeRenderer;
            if (badge) {
                const label = extractText(badge).toUpperCase();
                const style = badge.style;
                if (label === "LIVE" || label === "LIVE NOW" || label === "PREMIERE" || style === "BADGE_STYLE_TYPE_LIVE_NOW") {
                    isLive = true;
                    break;
                }
            }
        }
    }

    if (!isLive && Array.isArray(v.thumbnailOverlays)) {
        for (let i = 0; i < v.thumbnailOverlays.length; i++) {
            const overlay = v.thumbnailOverlays[i]?.thumbnailOverlayTimeStatusRenderer;
            if (overlay) {
                const style = overlay.style;
                const text = extractText(overlay.text).toUpperCase();
                if (style === "LIVE" || text === "LIVE" || text === "LIVE NOW") {
                    isLive = true;
                    break;
                }
            }
        }
    }

    if (!isLive && lengthStr.trim().toUpperCase() === "LIVE") {
        isLive = true;
    }

    const thumbObj = v.thumbnail || v.musicThumbnailRenderer?.thumbnail;
    const thumbnail = selectThumbnail(thumbObj, videoId);

    return sanitizeTrackMetadata({
        title,
        author,
        sourceId: videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
        duration,
        thumbnail,
        isLive
    });
}

/**
 * Search Video Tracks via InnerTube API
 */
export async function searchInnerTube(query: string, limit: number = 1): Promise<TrackMetadata[]> {
    if (!query || typeof query !== "string") return [];

    const normQuery = normalizeSearchQuery(query);
    if (!normQuery) return [];

    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || 1)));
    const cacheKey = `${normQuery}:${safeLimit}`;

    // Check positive cache
    const cachedPositive = positiveSearchCache.get(cacheKey);
    if (cachedPositive && Date.now() < cachedPositive.expiresAt) {
        return cachedPositive.data;
    }

    // Check negative cache
    const cachedNegative = negativeSearchCache.get(cacheKey);
    if (cachedNegative && Date.now() < cachedNegative.expiresAt) {
        return cachedNegative.data;
    }

    return searchSingleflight.do(cacheKey, async () => {
        try {
            const data = await postInnerTubeApi("search", () => ({ query: normQuery }));
            if (!data || typeof data !== "object") {
                negativeSearchCache.set(cacheKey, { data: [], expiresAt: Date.now() + 2 * 60 * 1000 });
                return [];
            }

            const rawRenderers = extractSearchRenderers(data);
            const results: TrackMetadata[] = [];
            const seenVideoIds = new Set<string>();

            for (let i = 0; i < rawRenderers.length; i++) {
                const parsed = parseSearchItem(rawRenderers[i]);
                if (!parsed) continue;

                const vId = parsed.sourceId;
                if (vId && !seenVideoIds.has(vId)) {
                    seenVideoIds.add(vId);
                    results.push(parsed);
                    if (results.length >= safeLimit) break;
                }
            }

            if (results.length > 0) {
                positiveSearchCache.set(cacheKey, { data: results, expiresAt: Date.now() + 15 * 60 * 1000 });
            } else {
                negativeSearchCache.set(cacheKey, { data: [], expiresAt: Date.now() + 2 * 60 * 1000 });
            }

            return results;
        } catch {
            return [];
        }
    });
}
