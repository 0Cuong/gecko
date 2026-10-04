import type { Song } from "../queue/types.js";
import { resolvePlayableStream, type PlayableStream } from "../sources/stream-resolver.js";
export class StreamUnavailableError extends Error {
    public readonly code?: string;
    constructor(message = "The requested source stream is unavailable.", code?: string, public override readonly cause?: unknown) {
        super(message);
        this.name = "StreamUnavailableError";
        this.code = code;
    }
}
export interface GetStreamOptions {
    /** Recovery must never reuse a direct media URL that has already failed. */
    forceRefresh?: boolean;
}

export async function getStream(song: Song, options: GetStreamOptions = {}): Promise<PlayableStream> {
    try {
        return await resolvePlayableStream(song, { forceRefresh: options.forceRefresh });
    } catch (error) {
        const code = (error as any)?.code;
        const msg = error instanceof Error ? error.message : String(error);
        throw new StreamUnavailableError(msg, code, error);
    }
}
