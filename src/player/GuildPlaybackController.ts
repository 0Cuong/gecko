import {
    AudioPlayerStatus,
    entersState,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { GeckoClient } from "../client/GeckoClient.js";
import { buildFfmpegFilterArgs } from "./filter.js";
import type { Song } from "../queue/types.js";
import { buildSongFromTrack } from "../queue/types.js";
import type { GuildQueue } from "../queue/GuildQueue.js";
import { embed } from "../utils/embeds.js";
import { metrics } from "../utils/metrics.js";
import { getStream } from "./stream.js";
import type { PlayableStream } from "../sources/stream-resolver.js";
import { AudioPipeline } from "./AudioPipeline.js";
import { RetryManager } from "./RetryManager.js";
import { fetchRelatedTracks } from "../sources/resolver.js";
import { invalidateStreamCache } from "../sources/ytdlp-wrapper.js";
import { logMusic } from "./MusicLogger.js";

const PLAYER_START_TIMEOUT_MS = 6_000;
const VOICE_RECONNECT_ATTEMPTS = 5;
const VOICE_RECONNECT_TIMEOUT_MS = 8_000;
const PREFETCH_WINDOW_MS = 25_000;

const MAX_AUTOPLAY_HISTORY_SIZE = 100;

interface ActivePlayback {
    token: number;
    track: Song;
    pipeline: AudioPipeline;
    started: boolean;
}

interface PrefetchedStream {
    trackId: string;
    streamPromise: Promise<PlayableStream>;
}

export class GuildPlaybackController {
    private readonly retryManager = new RetryManager();
    private active: ActivePlayback | null = null;
    private token = 0;
    private starting = false;
    private destroyed = false;
    private reconnecting = false;
    private retryTimer: NodeJS.Timeout | null = null;
    private prefetchTimer: NodeJS.Timeout | null = null;
    private ignoreNextIdle = false;
    private idleAnnounced = false;
    private failedToken: number | null = null;

    private prefetchedTrack: PrefetchedStream | null = null;
    private forceFreshStream = false;
    /** Serializes terminal transitions emitted synchronously by Discord Voice. */
    private transitionLock = false;
    private pendingTransitions: Array<{ operation: string; action: () => void }> = [];

    private readonly autoplayHistory = new Set<string>();
    private readonly autoplayHistoryOrder: string[] = [];
    private consecutiveSimilarAutoplays = 0;

    private readonly onPlayerStateChange = this.handlePlayerStateChange.bind(this);
    private readonly onPlayerError = this.handlePlayerError.bind(this);
    private readonly onConnectionStateChange = this.handleConnectionStateChange.bind(this);
    private readonly onVolumeChange = this.handleVolumeChange.bind(this);

    public constructor(
        private readonly client: GeckoClient,
        private readonly guildId: string,
        private readonly queue: GuildQueue,
    ) {
        metrics.registerPlayer();
        this.queue.attachController(this);
        this.queue.player.on("stateChange", this.onPlayerStateChange);
        this.queue.on("playerError", this.onPlayerError);
        this.queue.on("connectionStateChange", this.onConnectionStateChange);
        this.queue.on("volumeChange", this.onVolumeChange);
    }

    public async ensurePlayback(): Promise<void> {
        if (this.destroyed || this.queue.isDestroyed || this.starting) return;
        if (this.active || this.queue.player.state.status !== AudioPlayerStatus.Idle) return;

        this.starting = true;
        let track: Song | null = null;
        let token = 0;

        try {
            track = this.queue.current();
            if (!track && this.queue.autoplay) track = await this.enqueueAutoplayTrack();
            if (!track) {
                this.enterIdle();
                return;
            }
            const selectedTrack = track;

            this.idleAnnounced = false;
            this.queue.clearIdleTimeout();
            token = ++this.token;
            this.failedToken = null;

            const connection = this.queue.connection;
            if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
                throw new Error("Voice connection is unavailable.");
            }

            this.queue.setLifecycle("LOADING");

            const connectionPromise = (connection.state.status === VoiceConnectionStatus.Ready)
                ? Promise.resolve(connection)
                : entersState(connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_TIMEOUT_MS);

            const forceRefresh = this.forceFreshStream;
            this.forceFreshStream = false;
            const streamPromise = this.resolveOrUsePrefetchedStream(selectedTrack, forceRefresh);

            const [_, stream] = await Promise.all([connectionPromise, streamPromise]);

            if (this.destroyed || this.queue.isDestroyed || this.token !== token) {
                stream.cleanup();
                return;
            }

            const pipeline = new AudioPipeline(stream.type === "direct" && stream.mediaUrl ? { url: stream.mediaUrl, headers: stream.headers } : stream.stream, {
                filterArgs: buildFfmpegFilterArgs({
                    preset: this.queue.audioFilter,
                    speed: 1,
                    volume: 1,
                }),
                onError: (error) => this.runTransition("pipeline-error", () => this.handlePlaybackFailure(token, selectedTrack, error)),
                onCleanup: stream.cleanup,
            });

            this.active = { token, track: selectedTrack, pipeline, started: false };

            const rawVolume = this.queue.volume;
            const volume = Number.isFinite(rawVolume)
                ? Math.max(0.01, Math.min(2.0, rawVolume > 2 ? rawVolume / 100 : rawVolume))
                : 1.0;

            if (pipeline.resource.volume) {
                pipeline.resource.volume.setVolume(volume);
            }

            const subscription = connection.subscribe(this.queue.player);
            if (!subscription) throw new Error("Discord voice subscription could not be created.");

            this.queue.currentSong = selectedTrack;
            this.queue.player.play(pipeline.resource);

            this.triggerPrefetchNextTrack(token, selectedTrack);

            await entersState(this.queue.player, AudioPlayerStatus.Playing, PLAYER_START_TIMEOUT_MS);
            if (this.active?.token === token) this.markStarted();
        } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            const failedTrack = track;
            if (failedTrack) this.runTransition("start-failure", () => this.handlePlaybackFailure(token, failedTrack, error));
            else logMusic("ERROR", { guildId: this.guildId, operation: "ensure-playback", state: this.queue.lifecycle, error });
        } finally {
            this.starting = false;
            // A skip/stop may invalidate an in-flight extraction while it is awaiting IO.
            // Starting the new head here prevents the queue from becoming stuck at Idle.
            if (!this.destroyed && !this.queue.isDestroyed && this.token !== token) this.scheduleEnsurePlayback();
        }
    }

    public isStarting(): boolean {
        return this.starting;
    }

    public isPlaying(): boolean {
        return Boolean(this.active) || this.starting;
    }

    public skip(advance = true): void {
        this.runTransition("skip", () => this.skipLocked(advance));
    }

    private skipLocked(advance = true): void {
        if (this.destroyed) return;
        const wasStarting = this.starting;
        this.token += 1;
        this.clearRetryTimer();
        this.clearPrefetchTimer();
        this.clearPrefetch();

        if (this.active) {
            const pipeline = this.active.pipeline;
            this.active = null;
            pipeline.close();
        }

        if (this.queue.loopMode === "track") {
            this.queue.skipTrackLoop = true;
        }

        const playerWasActive = this.queue.player.state.status !== AudioPlayerStatus.Idle;
        this.ignoreNextIdle = playerWasActive;
        if (playerWasActive) {
            this.queue.player.stop(true);
        }

        this.retryManager.reset();
        this.queue.setLifecycle("STOPPED");
        this.queue.setPlaying(false);
        if (advance) {
            this.queue.advance();
        }
        if (!wasStarting) {
            this.scheduleEnsurePlayback();
        }
    }

    public stop(): void {
        this.runTransition("stop", () => this.stopLocked());
    }

    private stopLocked(): void {
        if (this.destroyed) return;
        this.token += 1;
        this.clearRetryTimer();
        this.clearPrefetchTimer();
        this.clearPrefetch();

        if (this.active) {
            const pipeline = this.active.pipeline;
            this.active = null;
            pipeline.close();
        }

        const playerWasActive = this.queue.player.state.status !== AudioPlayerStatus.Idle;
        this.ignoreNextIdle = playerWasActive;
        if (playerWasActive) {
            this.queue.player.stop(true);
        }

        this.retryManager.reset();
        this.queue.clearAll();
        void this.queue.cleanupNowPlayingMessage();
        this.queue.setLifecycle("STOPPED");
        this.queue.setPlaying(false);
        this.enterIdle();
    }

    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.clearRetryTimer();
        this.clearPrefetchTimer();
        this.clearPrefetch();
        this.pendingTransitions.length = 0;

        this.autoplayHistory.clear();
        this.autoplayHistoryOrder.length = 0;
        this.consecutiveSimilarAutoplays = 0;

        this.queue.player.off("stateChange", this.onPlayerStateChange);
        this.queue.off("playerError", this.onPlayerError);
        this.queue.off("connectionStateChange", this.onConnectionStateChange);
        this.queue.off("volumeChange", this.onVolumeChange);

        if (this.active) {
            const pipeline = this.active.pipeline;
            this.active = null;
            pipeline.close();
        }

        this.queue.detachController(this);
        metrics.unregisterPlayer();
    }

    private handlePlayerStateChange(
        oldState: { status: AudioPlayerStatus },
        newState: { status: AudioPlayerStatus },
    ): void {
        if (this.destroyed) return;

        switch (newState.status) {
            case AudioPlayerStatus.Buffering:
                this.queue.setLifecycle("BUFFERING");
                break;
            case AudioPlayerStatus.Playing:
                this.markStarted();
                break;
            case AudioPlayerStatus.Paused:
            case AudioPlayerStatus.AutoPaused:
                this.queue.setLifecycle("PAUSED");
                break;
            case AudioPlayerStatus.Idle:
                if (oldState.status !== AudioPlayerStatus.Idle) {
                    if (this.ignoreNextIdle) {
                        this.ignoreNextIdle = false;
                        return;
                    }
                    this.runTransition("track-end", () => this.completeCurrentTrack());
                }
                break;
        }
    }

    private handlePlayerError(error: Error): void {
        const active = this.active;
        if (active) this.runTransition("player-error", () => this.handlePlaybackFailure(active.token, active.track, error));
    }

    private handleConnectionStateChange(status: VoiceConnectionStatus): void {
        // /stop and queue.destroy intentionally destroy the voice connection. It
        // must not be converted into a second cleanup/error notification.
        if (this.destroyed || this.queue.isDestroyed) return;
        if (status === VoiceConnectionStatus.Destroyed) {
            this.removeAfterVoiceFailure("Voice connection was destroyed.");
        } else if (status === VoiceConnectionStatus.Disconnected) {
            void this.reconnectVoice().catch((error: unknown) => logMusic("ERROR", {
                guildId: this.guildId,
                operation: "voice-reconnect",
                state: this.queue.lifecycle,
                error: error instanceof Error ? error : new Error(String(error)),
            }));
        }
    }

    private handleVolumeChange(newVolume: number): void {
        if (this.destroyed) return;
        const volume = Number.isFinite(newVolume)
            ? Math.max(0.01, Math.min(2.0, newVolume > 2 ? newVolume / 100 : newVolume))
            : 1.0;
        if (this.active?.pipeline.resource.volume) {
            this.active.pipeline.resource.volume.setVolume(volume);
        }
    }

    private markStarted(): void {
        const active = this.active;
        if (!active || active.started) return;
        active.started = true;
        this.retryManager.reset(active.track.id);
        this.queue.setLifecycle("PLAYING");
        metrics.recordPlaySuccess();
        if (!this.queue.suppressNowPlaying) this.queue.queueUpdate?.(this.client);
    }

    private completeCurrentTrack(): void {
        const active = this.active;
        if (!active) return;
        this.token += 1;
        this.clearRetryTimer();
        this.clearPrefetchTimer();
        this.active = null;
        active.pipeline.close();
        this.retryManager.reset();
        this.queue.setLifecycle("FINISHED");
        this.queue.setPlaying(false);
        this.queue.advance();
        this.scheduleEnsurePlayback();
    }

    private handlePlaybackFailure(token: number, track: Song, error: Error): void {
        if (this.destroyed || token !== this.token || this.failedToken === token) return;
        this.failedToken = token;
        const active = this.active;
        if (active && active.token !== token) return;

        metrics.recordPlayFail();
        metrics.recordStreamInterruption();
        // FFmpeg rejected the input or the transport failed: do not retry a cached CDN URL.
        invalidateStreamCache(track.playbackUrl ?? track.canonicalUrl);

        if (active) {
            this.active = null;
            active.pipeline.close();
        }

        const playerWasActive = this.queue.player.state.status !== AudioPlayerStatus.Idle;
        this.ignoreNextIdle = playerWasActive;
        if (playerWasActive) this.queue.player.stop(true);

        const decision = this.retryManager.next(track.id, error);
        logMusic(decision.retry ? "WARN" : "ERROR", {
            guildId: this.guildId,
            track: track.id,
            operation: "playback-failure",
            errorType: decision.strategy,
            retryCount: decision.attempt,
            state: this.queue.lifecycle,
            error,
        });
        if (decision.retry) {
            this.queue.setLifecycle("BUFFERING");
            this.forceFreshStream = decision.refreshStream;
            this.scheduleRetry(decision.delayMs);
            return;
        }

        this.retryManager.reset();
        this.queue.setPlaying(false);
        this.queue.advance();

        const channel = this.queue.textChannel(this.client);
        if (channel) {
            void channel.send({
                embeds: [embed("error", `❌ Skipped **${track.title.slice(0, 80)}** after playback failed: ${error.message.slice(0, 180)}`)],
            }).catch((sendError: unknown) => logMusic("WARN", {
                guildId: this.guildId,
                track: track.id,
                operation: "send-track-failure",
                error: sendError instanceof Error ? sendError : new Error(String(sendError)),
            }));
        }
        this.scheduleEnsurePlayback();
    }

    private scheduleEnsurePlayback(): void {
        queueMicrotask(() => {
            void this.ensurePlayback().catch((err) => {
                logMusic("ERROR", { guildId: this.guildId, operation: "scheduled-ensure", state: this.queue.lifecycle, error: err instanceof Error ? err : new Error(String(err)) });
            });
        });
    }

    private scheduleRetry(delayMs: number): void {
        this.clearRetryTimer();
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.ensurePlayback().catch((err) => {
                logMusic("ERROR", { guildId: this.guildId, operation: "scheduled-retry", state: this.queue.lifecycle, error: err instanceof Error ? err : new Error(String(err)) });
            });
        }, delayMs);
        this.retryTimer.unref();
    }

    private enterIdle(): void {
        if (this.destroyed || this.queue.isDestroyed) return;
        this.queue.setPlaying(false);
        this.queue.setLifecycle("IDLE");
        if (!this.idleAnnounced) {
            this.idleAnnounced = true;
            const channel = this.queue.textChannel(this.client);
            if (channel) {
                void channel.send({ embeds: [embed("info", "⏹️ Queue ended. Use `/play` to add more music.")] }).catch((error: unknown) => logMusic("WARN", { guildId: this.guildId, operation: "send-idle", error: error instanceof Error ? error : new Error(String(error)) }));
            }
        }
        this.queue.startIdleTimeout(async () => {
            const channel = this.queue.textChannel(this.client);
            await this.queue.cleanupNowPlayingMessage();
            this.destroy();
            this.queue.destroy();
            this.client.queues.delete(this.guildId);
            if (channel) {
                await channel.send({ embeds: [embed("info", "👋 Left the voice channel due to inactivity.")] }).catch((error: unknown) => logMusic("WARN", { guildId: this.guildId, operation: "send-idle-disconnect", error: error instanceof Error ? error : new Error(String(error)) }));
            }
        }, this.client.config.idleTimeout);
    }

    private async reconnectVoice(): Promise<void> {
        if (this.reconnecting || this.destroyed || this.queue.isDestroyed) return;
        const connection = this.queue.connection;
        if (!connection) return;
        this.reconnecting = true;
        this.queue.setLifecycle("RECONNECTING");

        try {
            for (let attempt = 1; attempt <= VOICE_RECONNECT_ATTEMPTS; attempt += 1) {
                if (this.destroyed || this.queue.isDestroyed || this.queue.connection !== connection) return;
                connection.rejoin();
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_TIMEOUT_MS);
                    connection.subscribe(this.queue.player);
                    metrics.recordVoiceReconnect();
                    const status = this.queue.player.state.status;
                    this.queue.setLifecycle(status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused ? "PAUSED" : status === AudioPlayerStatus.Idle ? "IDLE" : "PLAYING");
                    logMusic("INFO", { guildId: this.guildId, operation: "voice-reconnected", retryCount: attempt, state: this.queue.lifecycle });
                    return;
                } catch (error) {
                    logMusic("WARN", { guildId: this.guildId, operation: "voice-reconnect-attempt", errorType: "voice", retryCount: attempt, state: this.queue.lifecycle, error: error instanceof Error ? error : new Error(String(error)) });
                    if (attempt < VOICE_RECONNECT_ATTEMPTS) await delay(withJitter(1_000 * (2 ** (attempt - 1))));
                }
            }
            this.removeAfterVoiceFailure("Unable to reconnect to the voice gateway.");
        } finally {
            this.reconnecting = false;
        }
    }

    private removeAfterVoiceFailure(message: string): void {
        if (this.destroyed || this.queue.isDestroyed) return;
        const channel = this.queue.textChannel(this.client);
        this.destroy();
        this.queue.destroy();
        this.client.queues.delete(this.guildId);
        if (channel) void channel.send({ embeds: [embed("error", `❌ ${message}`)] }).catch((error: unknown) => logMusic("WARN", { guildId: this.guildId, operation: "send-voice-failure", error: error instanceof Error ? error : new Error(String(error)) }));
    }

    private async enqueueAutoplayTrack(): Promise<Song | null> {
        if (this.destroyed || this.queue.isDestroyed) return null;
        if (this.queue.songs.length >= this.queue.maxSize) return null;

        const history = this.queue.history;
        if (history.length === 0) return null;

        const seeds = history.slice(-5).reverse();

        for (let seedIdx = 0; seedIdx < seeds.length; seedIdx++) {
            const seed = seeds[seedIdx];
            if (!seed) continue;

            if (this.consecutiveSimilarAutoplays >= 3 && seedIdx < 2 && seeds.length > 2) {
                continue;
            }

            try {
                const candidates = await fetchRelatedTracks(seed, 10);
                if (!candidates || candidates.length === 0) continue;

                let bestCandidate: Song | null = null;
                let bestScore = -Infinity;

                for (let i = 0; i < candidates.length; i++) {
                    const candidate = candidates[i];
                    const candidateSong = buildSongFromTrack(candidate, candidate.requestedById ?? "autoplay", candidate.requestedBy ?? "Autoplay");
                    let score = this.scoreCandidate(candidateSong, this.queue.currentSong, this.queue.songs, history);

                    if (score > -Infinity) {
                        score += (candidates.length - i) * 2.0;
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        bestCandidate = candidateSong;
                    }
                }

                if (bestCandidate && bestScore > 0) {
                    const recentSong = history.at(-1);
                    if (recentSong) {
                        const sim = isSameBaseTitle(bestCandidate.title, recentSong.title);
                        const sameArtist = (bestCandidate.author || "").toLowerCase() === (recentSong.author || "").toLowerCase();

                        if (sim || sameArtist) {
                            this.consecutiveSimilarAutoplays++;
                        } else {
                            this.consecutiveSimilarAutoplays = 0;
                        }
                    }

                    const candId = bestCandidate.sourceId;
                    this.recordAutoplay(candId);

                    const added = this.queue.add(bestCandidate);
                    if (added) {
                        return bestCandidate;
                    }
                }
            } catch (error) {
                logMusic("DEBUG", { guildId: this.guildId, track: seed.id, operation: "autoplay-resolve", error: error instanceof Error ? error : new Error(String(error)) });
                continue;
            }
        }

        this.consecutiveSimilarAutoplays = 0;
        return null;
    }

    private scoreCandidate(candidate: Song, currentSong: Song | null, queueSongs: Song[], historySongs: Song[]): number {
        const candId = candidate.sourceId.trim();
        const candUrl = candidate.canonicalUrl.trim();
        const candTitle = candidate.title || "";
        const candAuthor = (candidate.author || "").trim().toLowerCase();

        if (!candId && !candUrl) return -Infinity;

        if (this.autoplayHistory.has(candId) || (candUrl && this.autoplayHistory.has(candUrl))) {
            return -Infinity;
        }

        if (currentSong) {
            const currId = currentSong.sourceId.trim();
            if (currId === candId || currId === candUrl) return -Infinity;
        }
        for (const qSong of queueSongs) {
            const qId = qSong.sourceId.trim();
            if (qId === candId || qId === candUrl) return -Infinity;
        }

        const recentHistory5 = historySongs.slice(-5);
        for (const prev of recentHistory5) {
            const prevId = prev.sourceId.trim();
            if (prevId === candId || prevId === candUrl) return -Infinity;

            if (isSameBaseTitle(candTitle, prev.title)) {
                return -Infinity;
            }
        }

        let score = 100.0;

        const recentArtists = historySongs
            .slice(-3)
            .map((p) => (p.author || "").trim().toLowerCase())
            .filter(Boolean);

        if (candAuthor && recentArtists.length > 0) {
            const sameArtistCount = recentArtists.filter(
                (a) => a === candAuthor || a.includes(candAuthor) || candAuthor.includes(a)
            ).length;

            if (sameArtistCount >= 2) {
                score -= 50.0;
            } else if (sameArtistCount === 1) {
                score -= 20.0;
            } else {
                score += 15.0;
            }
        }

        score += 20.0;

        if (candidate.duration <= 0) return -Infinity;
        if (candidate.duration >= 90 && candidate.duration <= 600) {
            score += 10.0;
        }

        return score;
    }

    private recordAutoplay(idOrUrl: string): void {
        if (!idOrUrl) return;
        if (!this.autoplayHistory.has(idOrUrl)) {
            this.autoplayHistory.add(idOrUrl);
            this.autoplayHistoryOrder.push(idOrUrl);
            if (this.autoplayHistoryOrder.length > MAX_AUTOPLAY_HISTORY_SIZE) {
                const oldest = this.autoplayHistoryOrder.shift();
                if (oldest) this.autoplayHistory.delete(oldest);
            }
        }
    }

    private async resolveOrUsePrefetchedStream(track: Song, forceRefresh: boolean): Promise<PlayableStream> {
        if (!forceRefresh && this.prefetchedTrack && this.prefetchedTrack.trackId === track.id) {
            const streamPromise = this.prefetchedTrack.streamPromise;
            this.prefetchedTrack = null;
            return streamPromise;
        }
        this.clearPrefetch();
        return getStream(track, { forceRefresh });
    }

    private triggerPrefetchNextTrack(token: number, track: Song): void {
        this.clearPrefetchTimer();
        const nextTrack: Song | undefined = (this.queue as any).peekNext?.() ?? (this.queue as any).tracks?.[0];
        if (!nextTrack) return;
        if (nextTrack.isLazy || nextTrack.source === "spotify") return;
        const delayMs = Math.max(0, Math.round(track.duration * 1_000) - PREFETCH_WINDOW_MS);
        this.prefetchTimer = setTimeout(() => {
            this.prefetchTimer = null;
            if (this.destroyed || this.active?.token !== token || this.queue.current()?.id !== track.id) return;
            const streamPromise = getStream(nextTrack).catch((error: unknown) => {
                if (this.prefetchedTrack?.trackId === nextTrack.id) this.prefetchedTrack = null;
                throw error;
            });
            // A failed background prefetch is not a playback failure, but it must still be observed.
            void streamPromise.catch((error: unknown) => logMusic("DEBUG", {
                guildId: this.guildId,
                track: nextTrack.id,
                operation: "prefetch-observer",
                error: error instanceof Error ? error : new Error(String(error)),
            }));
            this.prefetchedTrack = { trackId: nextTrack.id, streamPromise };
        }, delayMs);
        this.prefetchTimer.unref();
    }

    private clearPrefetch(): void {
        if (this.prefetchedTrack) {
            this.prefetchedTrack.streamPromise.then(
                (stream) => stream.cleanup(),
                (error: unknown) => logMusic("DEBUG", { guildId: this.guildId, operation: "prefetch-cleanup", error: error instanceof Error ? error : new Error(String(error)) }),
            );
            this.prefetchedTrack = null;
        }
    }

    private clearPrefetchTimer(): void {
        if (!this.prefetchTimer) return;
        clearTimeout(this.prefetchTimer);
        this.prefetchTimer = null;
    }

    private runTransition(operation: string, action: () => void): void {
        if (this.destroyed) return;
        if (this.transitionLock) {
            this.pendingTransitions.push({ operation, action });
            return;
        }
        this.transitionLock = true;
        try {
            action();
        } catch (error) {
            logMusic("ERROR", { guildId: this.guildId, operation, state: this.queue.lifecycle, error: error instanceof Error ? error : new Error(String(error)) });
        } finally {
            this.transitionLock = false;
        }
        // player.stop() emits Idle synchronously. Process it after the initiating
        // transition so skip/error cannot race a second queue.advance().
        while (!this.destroyed && this.pendingTransitions.length > 0) {
            const next = this.pendingTransitions.shift();
            if (next) this.runTransition(next.operation, next.action);
        }
    }

    private clearRetryTimer(): void {
        if (!this.retryTimer) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }
}

function extractBaseTitle(title: string): string {
    if (!title) return "";
    let s = title.toLowerCase().trim();
    s = s.replace(/[\(\[\{].*?[\)\]\}]/g, "");
    s = s.replace(/\b(official|video|music|lyric|lyrics|audio|mv|full|hd|4k|remix|live|cover|acoustic|version|ver)\b/g, "");
    s = s.replace(/[^\w\s]/g, "");
    return s.replace(/\s+/g, " ").trim();
}

function isSameBaseTitle(title1: string, title2: string): boolean {
    const b1 = extractBaseTitle(title1);
    const b2 = extractBaseTitle(title2);
    if (!b1 || !b2) return false;
    if (b1 === b2) return true;

    if (b1.length > 3 && b2.length > 3) {
        if (b1.includes(b2) || b2.includes(b1)) {
            return true;
        }
    }

    const w1 = new Set(b1.split(" ").filter(Boolean));
    const w2 = new Set(b2.split(" ").filter(Boolean));
    if (w1.size === 0 || w2.size === 0) return false;

    let intersection = 0;
    for (const word of w1) {
        if (w2.has(word)) intersection++;
    }

    const union = new Set([...w1, ...w2]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    return jaccard >= 0.6;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
}

function withJitter(delayMs: number): number {
    return Math.round(delayMs + Math.random() * delayMs * 0.15);
}
