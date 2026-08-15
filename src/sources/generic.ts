import { createHash } from "node:crypto";
import ytdl from "./ytdlp-wrapper.js";
import type { SourceResolver, TrackMetadata, TrackResolveOptions } from "./resolver.js";

function directTrack(entry: any, fallback: string, options: TrackResolveOptions): TrackMetadata {
    const webpageUrl = typeof entry?.webpage_url === "string" ? entry.webpage_url : fallback;
    const sourceId = typeof entry?.id === "string" && entry.id ? entry.id : createHash("sha256").update(webpageUrl).digest("hex").slice(0, 24);
    return { source: "direct", sourceId, canonicalUrl: webpageUrl, webpageUrl, title: typeof entry?.title === "string" ? entry.title : "Direct media", author: typeof entry?.uploader === "string" ? entry.uploader : "Unknown",
      duration: Number.isFinite(Number(entry?.duration)) ? Math.max(0, Number(entry.duration)) : 0, thumbnail: typeof entry?.thumbnail === "string" ? entry.thumbnail : "", isLive: entry?.is_live === true,
      engine: "yt-dlp", ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}), ...(options.requestedById ? { requestedById: options.requestedById } : {}) };
}
export class GenericResolver implements SourceResolver {
    public readonly name = "GenericResolver"; public readonly isFallback = true;
    public canResolve(url: string): boolean { try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:"; } catch { return false; } }
    public async resolve(url: string, options: TrackResolveOptions = {}): Promise<TrackMetadata | TrackMetadata[]> {
        const info: any = await ytdl(url, { dumpSingleJson: true, yesPlaylist: true, playlistEnd: options.limit ?? 100 });
        if (!info) throw new Error(`Could not resolve URL: ${url}`);
        return Array.isArray(info.entries) ? info.entries.filter(Boolean).map((entry: any) => directTrack(entry, url, options)) : directTrack(info, url, options);
    }
}
