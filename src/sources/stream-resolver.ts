import type { Readable } from "node:stream";
import { createAudioStream, safeKill, type AudioStreamResult } from "./ytdlp-wrapper.js";
import { defaultResolverManager, type TrackMetadata, type TrackSource } from "./resolver.js";

export interface PlayableStream {
    readonly type: "direct" | "pipe";
    readonly source: TrackSource | "youtube";
    readonly stream: Readable;
    readonly mediaUrl?: string;
    readonly headers?: Record<string, string>;
    readonly expiresAt?: number;
    readonly engine: string;
    /** Releases an extractor child process when a pipe result is abandoned. */
    cleanup(): void;
}
const EXPIRY_SKEW_MS = 60_000;
const blockedCrossSource: Record<TrackSource, readonly string[]> = { tiktok: ["youtube.com", "youtu.be", "googlevideo.com"], youtube: ["tiktok.com", "tiktokcdn.com", "byteoversea.com", "ibytedtos.com"], soundcloud: [], spotify: [], direct: [] };
function host(value: string): string { try { return new URL(value).hostname.toLowerCase(); } catch { return ""; } }
function hostMatches(value: string, domain: string): boolean { const h = host(value); return h === domain || h.endsWith(`.${domain}`); }
function sourceInput(track: TrackMetadata): { source: TrackSource | "youtube"; url: string } {
    if (track.source === "spotify") { if (track.playbackSource !== "youtube" || !track.playbackUrl || !track.mappingVerified) throw new Error("Spotify playback mapping is unavailable or was not verified."); return { source: "youtube", url: track.playbackUrl }; }
    return { source: track.source, url: track.canonicalUrl };
}
export function validateTrackIdentity(track: TrackMetadata): void { if (!track.sourceId || !track.canonicalUrl || !track.webpageUrl) throw new Error("Track has no stable source identity."); }
export function validateSource(track: TrackMetadata): void {
    if (track.source === "youtube" && !hostMatches(track.canonicalUrl, "youtube.com")) throw new Error("YouTube metadata has a non-YouTube canonical URL.");
    if (track.source === "tiktok" && !(hostMatches(track.canonicalUrl, "tiktok.com") || hostMatches(track.canonicalUrl, "vm.tiktok.com") || hostMatches(track.canonicalUrl, "vt.tiktok.com"))) throw new Error("TikTok metadata has a non-TikTok canonical URL.");
    if (track.source === "soundcloud" && !hostMatches(track.canonicalUrl, "soundcloud.com") && !hostMatches(track.canonicalUrl, "snd.sc")) throw new Error("SoundCloud metadata has a non-SoundCloud canonical URL.");
    if (track.source === "spotify" && !hostMatches(track.canonicalUrl, "spotify.com")) throw new Error("Spotify metadata has a non-Spotify canonical URL.");
}
export function validateDuration(track: TrackMetadata): void { if (!Number.isFinite(track.duration) || track.duration < 0) throw new Error("Track duration is invalid."); }
export function validateExpiry(expiresAt?: number): void { if (expiresAt !== undefined && Date.now() >= expiresAt - EXPIRY_SKEW_MS) throw new Error("Resolved stream URL is expired."); }
export function validateStream(track: TrackMetadata, streamSource: TrackSource | "youtube", mediaUrl?: string): void {
    if (track.source === "spotify") { if (streamSource !== "youtube" || !track.mappingVerified) throw new Error("Unverified Spotify source mapping blocked."); return; }
    if (streamSource !== track.source) throw new Error(`Cross-source stream blocked: ${track.source} -> ${streamSource}`);
    if (!mediaUrl) return;
    for (const domain of blockedCrossSource[track.source]) if (hostMatches(mediaUrl, domain)) throw new Error(`Cross-source media host blocked for ${track.source}: ${host(mediaUrl)}`);
}
/** The sole transition from source identity to a playable byte stream. */
export async function resolvePlayableStream(track: TrackMetadata, options: { forceRefresh?: boolean } = {}): Promise<PlayableStream> {
    validateTrackIdentity(track); validateSource(track); validateDuration(track);
    if (track.source === "spotify" && (!track.playbackUrl || track.isLazy)) {
        const resolver = defaultResolverManager.getResolvers().find((item) => item.name === "SpotifyResolver") as { resolveTrackOnDemand?(value: TrackMetadata): Promise<TrackMetadata> } | undefined;
        if (!resolver?.resolveTrackOnDemand) throw new Error("Spotify playback mapping is not configured."); Object.assign(track, await resolver.resolveTrackOnDemand(track));
    }
    const target = sourceInput(track); console.info(`[Stream] source=${track.source} id=${track.sourceId} engine=yt-dlp targetSource=${target.source}`);
    let extracted: AudioStreamResult;
    // TikTok CDN URLs are frequently bound to the extractor session and reject a
    // second client (FFmpeg) with 403. Keep the authenticated HTTP request inside
    // yt-dlp and pipe media bytes to FFmpeg instead of handing FFmpeg the signed URL.
    const forcePipe = target.source === "tiktok";
    try { extracted = await createAudioStream(target.url, { forceNoCache: options.forceRefresh === true || forcePipe, forcePipe }); } catch (error) { throw new Error(`Stream extraction failed for ${track.source}/${track.sourceId}: ${error instanceof Error ? error.message : String(error)}`); }
    validateExpiry(extracted.expiresAt); validateStream(track, target.source, extracted.url);
    if (extracted.type === "direct") {
        if (!extracted.url) throw new Error("Direct stream extraction returned no media URL.");
        Object.assign(track, { streamUrl: extracted.url, audioUrl: extracted.url, directUrl: extracted.url, streamType: "direct", expiresAt: extracted.expiresAt, engine: "yt-dlp", isLazy: false });
        const { Readable } = await import("node:stream"); return { type: "direct", source: target.source, stream: Readable.from([]), mediaUrl: extracted.url, headers: extracted.headers, expiresAt: extracted.expiresAt, engine: "yt-dlp", cleanup: () => undefined };
    }
    if (!extracted.stream) throw new Error("Pipe stream extraction returned no stream."); Object.assign(track, { streamType: "pipe", engine: "yt-dlp", isLazy: false });
    return { type: "pipe", source: target.source, stream: extracted.stream, engine: "yt-dlp", cleanup: () => { extracted.stream?.destroy(); safeKill(extracted.process, "playback-pipe-cleanup"); } };
}
