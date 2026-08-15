import type { TrackMetadata } from "../sources/resolver.js";
export interface Song extends TrackMetadata { id: string; requester: string; requesterId: string; }
export type LoopMode = "off" | "track" | "queue";
export type AudioFilterPreset = "none" | "bassboost" | "nightcore" | "slow" | "fast";
/** Queue lifecycle is intentionally broader than Discord's AudioPlayer statuses. */
export type PlayerLifecycleState =
    | "CREATED"
    | "CONNECTING"
    | "LOADING"
    | "BUFFERING"
    | "PLAYING"
    | "PAUSED"
    | "RECONNECTING"
    | "FINISHED"
    | "ERROR"
    | "STOPPED"
    | "IDLE"
    | "DESTROYED";
export function buildSongFromTrack(track: TrackMetadata, requesterId: string, requester: string): Song { return { ...track, id: `${track.source}:${track.sourceId}`, requester, requesterId, requestedBy: track.requestedBy ?? requester, requestedById: track.requestedById ?? requesterId }; }
