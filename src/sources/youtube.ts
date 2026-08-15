import ytdl from "./ytdlp-wrapper.js";
import type { SourceResolver, TrackMetadata, TrackResolveOptions } from "./resolver.js";
import { fetchInnerTubeVideo, searchInnerTube } from "./youtube-innertube.js";
import { LRUCache } from "../utils/cache.js";
import { Singleflight } from "./spotify.js";

const URL = /(?:youtube\.com|youtu\.be)\//i;
const ID = /(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([\w-]{11})/;
const VARIANT = /\b(remix|cover|karaoke|instrumental|sped\s*up|slowed|nightcore|live|mashup)\b/i;

function videoId(value: string): string | null { return ID.exec(value)?.[1] ?? null; }
function canonical(id: string): string { return `https://www.youtube.com/watch?v=${id}`; }
function trackFrom(entry: any): TrackMetadata {
    const id = typeof entry?.id === "string" ? entry.id : videoId(String(entry?.webpage_url ?? entry?.url ?? ""));
    if (!id) throw new Error("YouTube extractor returned no video ID.");
    return { source: "youtube", sourceId: id, canonicalUrl: canonical(id), webpageUrl: canonical(id),
        title: typeof entry?.title === "string" ? entry.title : "Unknown title", author: typeof entry?.uploader === "string" ? entry.uploader : typeof entry?.channel === "string" ? entry.channel : "Unknown artist",
        duration: Number.isFinite(Number(entry?.duration)) ? Math.max(0, Number(entry.duration)) : 0,
        thumbnail: typeof entry?.thumbnail === "string" ? entry.thumbnail : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, isLive: entry?.is_live === true || entry?.live_status === "is_live", engine: "yt-dlp" };
}

export class YoutubeResolver implements SourceResolver {
    public readonly name = "YoutubeResolver";
    private readonly resolveCache = new LRUCache<string, TrackMetadata | TrackMetadata[]>({ maxSize: 500, ttlMs: 30 * 60 * 1000 });
    private readonly searchCache = new LRUCache<string, TrackMetadata[]>({ maxSize: 500, ttlMs: 10 * 60 * 1000 });
    private readonly singleflight = new Singleflight<TrackMetadata | TrackMetadata[]>();
    public canResolve(url: string): boolean { return URL.test(url); }
    public async resolve(url: string, options: TrackResolveOptions = {}): Promise<TrackMetadata | TrackMetadata[]> {
        const id = videoId(url);
        if (!id) throw new Error("A YouTube URL must contain a video ID; it will not be searched by title.");
        const cacheKey = canonical(id); const cached = this.resolveCache.get(cacheKey); if (cached) return cached;
        return this.singleflight.do(`resolve:${id}`, 30_000, async () => {
            const inner = await fetchInnerTubeVideo(id).catch(() => null);
            if (inner) { this.resolveCache.set(cacheKey, inner); return inner; }
            try { const info = await ytdl(canonical(id), { dumpSingleJson: true, ...options }); const out = trackFrom(info); this.resolveCache.set(cacheKey, out); return out; }
            catch (error) { throw new Error(`YouTube resolution failed for video ${id}: ${error instanceof Error ? error.message : String(error)}`); }
        });
    }
    public async search(query: string, options: TrackResolveOptions = {}): Promise<TrackMetadata[]> {
        const limit = Math.max(1, Math.min(options.limit ?? 5, 25)); const key = `${query.trim().toLowerCase()}:${limit}`; const cached = this.searchCache.get(key); if (cached) return cached;
        let items = await searchInnerTube(query, Math.max(limit * 2, 10)).catch(() => []);
        if (!items.length) { const result: any = await ytdl(`ytsearch${Math.max(limit * 2, 10)}:${query}`, { dumpSingleJson: true, flatPlaylist: true }); items = Array.isArray(result?.entries) ? result.entries.map(trackFrom) : []; }
        const queryRequestsVariant = VARIANT.test(query);
        items.sort((a, b) => this.score(b, query, queryRequestsVariant) - this.score(a, query, queryRequestsVariant));
        const result = items.slice(0, limit); this.searchCache.set(key, result); return result;
    }
    public async fetchRelatedTracks(track: TrackMetadata, limit = 10): Promise<TrackMetadata[]> {
        if (track.source !== "youtube") return [];
        // Same provider only; these are suggestions, never a replacement for a URL.
        return (await this.search(`${track.title} ${track.author}`, { limit: limit + 3 })).filter((candidate) => candidate.sourceId !== track.sourceId).slice(0, limit);
    }
    private score(track: TrackMetadata, query: string, queryRequestsVariant: boolean): number {
        const text = `${track.title} ${track.author}`.toLowerCase(); let score = track.title.toLowerCase().includes(query.toLowerCase()) ? 100 : 50;
        if (!queryRequestsVariant && VARIANT.test(text)) score -= 80;
        if (!query.toLowerCase().includes("short") && track.duration > 0 && track.duration < 65) score -= 50;
        if (track.isLive && !/\blive\b/i.test(query)) score -= 60;
        return score;
    }
}
