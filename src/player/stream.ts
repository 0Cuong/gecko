import type { Song } from "../queue/types.js";
import { resolvePlayableStream, type PlayableStream } from "../sources/stream-resolver.js";
export class StreamUnavailableError extends Error { constructor(message = "The requested source stream is unavailable.") { super(message); this.name = "StreamUnavailableError"; } }
export interface GetStreamOptions {
    /** Recovery must never reuse a direct media URL that has already failed. */
    forceRefresh?: boolean;
}

export async function getStream(song: Song, options: GetStreamOptions = {}): Promise<PlayableStream> {
    try {
        return await resolvePlayableStream(song, { forceRefresh: options.forceRefresh });
    } catch (error) {
        throw new StreamUnavailableError(error instanceof Error ? error.message : String(error));
    }
}
