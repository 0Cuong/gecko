import ytdl from "./ytdlp-wrapper.js";
import type { SourceResolver, TrackMetadata, TrackResolveOptions } from "./resolver.js";

const URL = /^https?:\/\/(?:www\.|m\.)?(?:soundcloud\.com|snd\.sc)\//i;
function toTrack(entry: any, fallback: string, options: TrackResolveOptions = {}): TrackMetadata {
    const webpageUrl = typeof entry?.webpage_url === "string" && URL.test(entry.webpage_url) ? entry.webpage_url : fallback;
    const sourceId = typeof entry?.id === "string" || typeof entry?.id === "number" ? String(entry.id) : webpageUrl;
    return { source: "soundcloud", sourceId, canonicalUrl: webpageUrl, webpageUrl, title: typeof entry?.title === "string" ? entry.title : "Unknown", author: typeof entry?.uploader === "string" ? entry.uploader : typeof entry?.creator === "string" ? entry.creator : "Unknown",
        duration: Number.isFinite(Number(entry?.duration)) ? Math.max(0, Number(entry.duration)) : 0, thumbnail: typeof entry?.thumbnail === "string" ? entry.thumbnail : "", isLive: entry?.is_live === true, engine: "yt-dlp",
        ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}), ...(options.requestedById ? { requestedById: options.requestedById } : {}) };
}
export class SoundcloudResolver implements SourceResolver {
    public readonly name = "SoundcloudResolver";
    public canResolve(url: string): boolean { return URL.test(url.trim()); }
    public async resolve(url: string, options: TrackResolveOptions = {}): Promise<TrackMetadata | TrackMetadata[]> {
        if (!this.canResolve(url)) throw new Error("Invalid SoundCloud URL.");
        const info: any = await ytdl(url, { dumpSingleJson: true, yesPlaylist: true, playlistEnd: options.limit ?? 100 }, { signal: options.signal });
        if (!info) throw new Error("SoundCloud returned no metadata.");
        return Array.isArray(info.entries) ? info.entries.filter(Boolean).map((entry: any) => toTrack(entry, url, options)) : toTrack(info, url, options);
    }
    public async search(query: string, options: TrackResolveOptions = {}): Promise<TrackMetadata[]> {
        const info: any = await ytdl(`scsearch${Math.max(1, Math.min(options.limit ?? 5, 25))}:${query}`, { dumpSingleJson: true, flatPlaylist: true }, { signal: options.signal });
        return Array.isArray(info?.entries) ? info.entries.filter(Boolean).map((entry: any) => toTrack(entry, "", options)) : [];
    }
    public async fetchRelatedTracks(track: TrackMetadata, limit = 10): Promise<TrackMetadata[]> {
        if (track.source !== "soundcloud") return [];
        return (await this.search(`${track.author} ${track.title}`, { limit: limit + 3 })).filter((item) => item.sourceId !== track.sourceId).slice(0, limit);
    }
}
