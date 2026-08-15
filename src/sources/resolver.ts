import { TikTokResolver } from "./tiktok.js";
import { YoutubeResolver } from "./youtube.js";
import { SpotifyResolver } from "./spotify.js";
import { SoundcloudResolver } from "./soundcloud.js";
import { GenericResolver } from "./generic.js";
import { securityManager } from "../utils/security.js";
import { isHttpUrl } from "../utils/url.js";

export type TrackSource = "youtube" | "soundcloud" | "spotify" | "tiktok" | "direct";
export type StreamType = "direct" | "pipe";

/** Immutable identity returned by source resolvers.  A media URL is never a substitute for a webpage URL. */
export interface TrackMetadata {
    source: TrackSource;
    sourceId: string;
    canonicalUrl: string;
    webpageUrl: string;
    title: string;
    author: string;
    duration: number;
    thumbnail: string;
    isLive: boolean;
    requestedBy?: string;
    requestedById?: string;
    engine?: string;
    /** Ephemeral fields are populated only by StreamResolver, never by metadata caches. */
    streamUrl?: string;
    audioUrl?: string;
    directUrl?: string;
    streamType?: StreamType;
    isLazy?: boolean;
    expiresAt?: number;
    /** Explicit, verified Spotify -> YouTube mapping. No other cross-source mapping is allowed. */
    playbackSource?: "youtube";
    playbackUrl?: string;
    playbackSourceId?: string;
    mappingVerified?: boolean;
    spotifyUrl?: string;
    isrc?: string;
    primaryArtist?: string;
    featuredArtists?: string[];
    album?: string;
    explicit?: boolean;
}

export interface TrackResolveOptions {
    source?: "youtube" | "soundcloud";
    limit?: number;
    requestedBy?: string;
    requestedById?: string;
    isUrl?: boolean;
    signal?: AbortSignal;
}

export interface TrackResolver {
    name: string;
    isFallback?: boolean;
    canResolve(url: string): boolean;
    resolve(url: string, options?: TrackResolveOptions): Promise<TrackMetadata | TrackMetadata[]>;
    search?(query: string, options?: TrackResolveOptions): Promise<TrackMetadata[]>;
    fetchRelatedTrack?(track: TrackMetadata): Promise<TrackMetadata | null>;
    fetchRelatedTracks?(track: TrackMetadata, limit?: number): Promise<TrackMetadata[]>;
}

export type SourceResolver = TrackResolver;
const URI_SCHEME_REGEX = /^[a-z][a-z\d+.-]*:/i;

function hasUriScheme(input: string): boolean { return URI_SCHEME_REGEX.test(input); }

export class ResolverManager {
    private resolvers: SourceResolver[] = [];
    public register(resolver: SourceResolver): void { this.resolvers.push(resolver); }
    public getResolvers(): SourceResolver[] { return [...this.resolvers]; }

    public async search(query: string, options: TrackResolveOptions = {}): Promise<TrackMetadata[]> {
        const normalized = query.trim();
        if (!normalized) return [];
        for (const resolver of this.resolvers) {
            if (resolver.isFallback || !resolver.search) continue;
            if (options.source && resolver.name.toLowerCase() !== `${options.source}resolver`) continue;
            try {
                const results = await resolver.search(normalized, options);
                if (results.length) return results;
            } catch (error) {
                if (options.signal?.aborted) throw error;
                console.warn(`[Resolver] search source=${resolver.name} failed`);
            }
        }
        return [];
    }

    public async resolve(inputValue: string, options: TrackResolveOptions = {}): Promise<TrackMetadata | TrackMetadata[]> {
        const input = inputValue.trim();
        if (!input) throw new Error("A URL or search query is required.");
        if (isHttpUrl(input)) {
            await securityManager.assertPublicHttpUrl(input);
            const resolver = this.findResolver(input, true);
            if (!resolver) throw new Error(`No resolver found for URL: ${input}`);
            // URL resolution is terminal: never fall through to search or another source.
            return resolver.resolve(input, options);
        }
        if (hasUriScheme(input)) {
            const resolver = this.findResolver(input, false);
            if (resolver) return resolver.resolve(input, options);
            throw new Error(`No resolver found for URI: ${input}`);
        }
        const results = await this.search(input, options);
        if (!results.length) throw new Error(`No search results found for query: ${input}`);
        return results;
    }

    private findResolver(input: string, includeFallback: boolean): SourceResolver | undefined {
        return this.resolvers.find((resolver) => includeFallback || !resolver.isFallback ? resolver.canResolve(input) : false);
    }
}

export function createDefaultResolverManager(): ResolverManager {
    const manager = new ResolverManager();
    const youtube = new YoutubeResolver();
    manager.register(new TikTokResolver()); // TikTok is deliberately self-contained.
    manager.register(new SpotifyResolver(youtube)); // the only permitted cross-source mapper
    manager.register(youtube);
    manager.register(new SoundcloudResolver());
    manager.register(new GenericResolver());
    return manager;
}

export const defaultResolverManager = createDefaultResolverManager();
export function resolve(input: string, options: TrackResolveOptions = {}): Promise<TrackMetadata | TrackMetadata[]> { return defaultResolverManager.resolve(input, options); }
export function search(query: string, options: TrackResolveOptions = {}): Promise<TrackMetadata[]> { return defaultResolverManager.search(query, options); }

/** Related playback is strictly source-local.  There is intentionally no global search fallback. */
export async function fetchRelatedTracks(track: TrackMetadata, limit = 10): Promise<TrackMetadata[]> {
    const resolver = defaultResolverManager.getResolvers().find((item) => item.name.toLowerCase() === `${track.source}resolver`);
    if (!resolver) return [];
    try {
        const items: Array<TrackMetadata | null> = resolver.fetchRelatedTracks
            ? await resolver.fetchRelatedTracks(track, limit)
            : resolver.fetchRelatedTrack ? await Promise.all([resolver.fetchRelatedTrack(track)]) : [];
        return items.filter((item): item is TrackMetadata => item !== null && item.source === track.source && item.sourceId !== track.sourceId).slice(0, limit);
    } catch (error) {
        console.warn(`[Autoplay] source=${track.source} id=${track.sourceId} related failed`);
        return [];
    }
}
export async function fetchRelatedTrack(track: TrackMetadata): Promise<TrackMetadata | null> { return (await fetchRelatedTracks(track, 1))[0] ?? null; }
