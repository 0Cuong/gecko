import ytdl, { isTikTokUrl } from "./ytdlp-wrapper.js";
import type { SourceResolver, TrackMetadata, TrackResolveOptions } from "./resolver.js";
import { LRUCache } from "../utils/cache.js";
import { securityManager } from "../utils/security.js";

const METADATA_TTL = 60 * 60 * 1000;
const shortUrl = /(?:vm|vt)\.tiktok\.com/i;
const videoIdPattern = /\/video\/(\d+)/i;

function canonical(input: string): string { const u = new URL(input); u.search = ""; u.hash = ""; return u.toString().replace(/\/$/, ""); }
function idFrom(url: string, raw?: unknown): string {
    if (typeof raw === "string" && raw) return raw;
    return videoIdPattern.exec(url)?.[1] ?? canonical(url);
}
function requested(options: TrackResolveOptions) { return { ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}), ...(options.requestedById ? { requestedById: options.requestedById } : {}) }; }

/** Resolves TikTok identity only. Audio extraction happens JIT in StreamResolver and never searches YouTube. */
export class TikTokResolver implements SourceResolver {
    public readonly name = "TikTokResolver";
    private readonly metadata = new LRUCache<string, TrackMetadata>({ maxSize: 500, ttlMs: METADATA_TTL });
    private readonly inFlight = new Map<string, Promise<TrackMetadata>>();

    public canResolve(input: string): boolean { return isTikTokUrl(input); }

    public async resolve(input: string, options: TrackResolveOptions = {}): Promise<TrackMetadata> {
        if (!this.canResolve(input)) throw new Error("Invalid TikTok URL.");
        const expanded = shortUrl.test(input) ? await this.expandShortUrl(input) : input;
        if (!this.canResolve(expanded)) throw new Error("TikTok short URL did not redirect to a TikTok resource.");
        const key = canonical(expanded);
        const cached = this.metadata.get(key);
        if (cached) return { ...cached, ...requested(options) };
        const pending = this.inFlight.get(key);
        if (pending) return { ...(await pending), ...requested(options) };
        const task = this.extractMetadata(key);
        this.inFlight.set(key, task);
        try { const track = await task; this.metadata.set(key, track); return { ...track, ...requested(options) }; }
        finally { this.inFlight.delete(key); }
    }

    private async expandShortUrl(url: string): Promise<string> {
        await securityManager.assertPublicHttpUrl(url);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5_000);
            const response = await fetch(url, {
                method: "GET",
                redirect: "manual",
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const loc = response.headers.get("location");
            const finalUrl = typeof loc === "string" && loc ? new URL(loc, url).toString() : url;
            return finalUrl;
        } catch (error) { throw new Error(`TikTok short URL expansion failed: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private async extractMetadata(url: string): Promise<TrackMetadata> {
        // yt-dlp is a same-source technical extractor. It is never allowed to return another webpage.
        let info: any;
        try { info = await ytdl(url, { dumpSingleJson: true, _isRecovery: true }); }
        catch (error) { throw new Error(`TikTok extraction failed for this exact video: ${error instanceof Error ? error.message : String(error)}`); }
        const webpageUrl = canonical(typeof info?.webpage_url === "string" && this.canResolve(info.webpage_url) ? info.webpage_url : url);
        const sourceId = idFrom(webpageUrl, info?.id);
        if (!sourceId || !this.canResolve(webpageUrl)) throw new Error("TikTok extractor did not return TikTok identity.");
        return {
            source: "tiktok", sourceId, canonicalUrl: webpageUrl, webpageUrl,
            title: typeof info?.title === "string" && info.title.trim() ? info.title.trim() : "TikTok video",
            author: typeof info?.uploader === "string" ? info.uploader : typeof info?.channel === "string" ? info.channel : "TikTok user",
            duration: Number.isFinite(Number(info?.duration)) ? Math.max(0, Number(info.duration)) : 0,
            thumbnail: typeof info?.thumbnail === "string" ? info.thumbnail : "",
            isLive: info?.is_live === true || info?.live_status === "is_live", engine: "yt-dlp",
        };
    }
}
