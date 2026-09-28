import { EventEmitter } from "node:events";
import {
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    NoSubscriberBehavior,
    VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Message, TextBasedChannel } from "discord.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import type { AudioFilterPreset, LoopMode, PlayerLifecycleState, Song } from "./types.js";

const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_QUEUE_LIMIT = 500;
const MAX_SAFE_VOLUME = 2.0;

export interface QueuePlaybackController {
    destroy(): void;
    skip?(advance?: boolean): void;
    stop?(): void;
}

export interface SendableTextChannel {
    send(payload: unknown): Promise<unknown>;
}

export interface UiPayloadResult {
    key: string;
    payload: unknown;
}

export class GuildQueue extends EventEmitter {
    public songs: Song[] = [];
    public history: Song[] = [];
    public connection: VoiceConnection | null = null;
    public readonly player: AudioPlayer;
    public readonly textChannelId: string;
    public volume: number;
    public suppressNowPlaying = false;
    public shuffle = false;
    public audioFilter: AudioFilterPreset = "none";
    public currentSong: Song | null = null;
    public currentIndex = 0;
    public overrideNextIndex = -1;
    public repeatMode = 0;
    public loopMode: LoopMode = "off";
    public skipTrackLoop = false;
    public nowPlayingMessage: Message | null = null;
    public autoplay = false;
    public isDestroyed = false;
    public lifecycle: PlayerLifecycleState = "CREATED";

    public queueUpdate?(client: GeckoClient): void;

    public readonly maxSize: number;
    private idleTimeout: NodeJS.Timeout | null = null;
    private uiUpdateTimeout: NodeJS.Timeout | null = null;
    private lastUiPayloadKey: string | null = null;
    private controller: QueuePlaybackController | null = null;
    private readonly songSet = new Set<string>();

    private readonly onPlayerError = this.handlePlayerError.bind(this);
    private readonly onConnectionStateChange = this.handleConnectionStateChange.bind(this);

    public constructor(textChannelId: string, volume = 1, maxSize = DEFAULT_QUEUE_LIMIT) {
        super();
        this.textChannelId = textChannelId;
        const normalizedVol = volume > 2 ? volume / 100 : volume;
        this.volume = Math.max(0.01, Math.min(MAX_SAFE_VOLUME, Number.isFinite(normalizedVol) ? normalizedVol : 1.0));
        this.maxSize = Math.max(1, maxSize);
        this.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
        });
        this.player.on("error", this.onPlayerError);
    }

    public isDefaultVolume(): boolean {
        return Math.abs(this.volume - 1.0) < 0.001;
    }

    public formatVolumeDisplay(): string | null {
        if (this.isDefaultVolume()) {
            return null;
        }
        return `${Math.round(this.volume * 100)}%`;
    }

    public setVolume(volume: number): number {
        const normalizedVol = volume > 2 ? volume / 100 : volume;
        this.volume = Math.max(0.01, Math.min(MAX_SAFE_VOLUME, Number.isFinite(normalizedVol) ? normalizedVol : 1.0));
        this.emit("volumeChange", this.volume);
        this.scheduleUiUpdate();
        return this.volume;
    }

    public scheduleUiUpdate(delayMs = 300): void {
        if (this.isDestroyed || !this.nowPlayingMessage) return;
        this.clearUiUpdateTimeout();
        this.uiUpdateTimeout = setTimeout(() => {
            this.uiUpdateTimeout = null;
            if (!this.isDestroyed && this.nowPlayingMessage && typeof this.queueUpdate === "function") {
                this.emit("uiUpdateRequested");
            }
        }, delayMs);
        this.uiUpdateTimeout.unref();
    }

    public clearUiUpdateTimeout(): void {
        if (this.uiUpdateTimeout) {
            clearTimeout(this.uiUpdateTimeout);
            this.uiUpdateTimeout = null;
        }
    }

    public async updateNowPlayingMessage(
        payloadBuilder: () => UiPayloadResult,
        force = false
    ): Promise<boolean> {
        if (this.isDestroyed || !this.nowPlayingMessage) {
            return false;
        }

        try {
            const { key, payload } = payloadBuilder();
            if (!force && key === this.lastUiPayloadKey) {
                return false;
            }

            this.lastUiPayloadKey = key;
            await this.nowPlayingMessage.edit(payload as Parameters<Message["edit"]>[0]);
            return true;
        } catch {
            this.nowPlayingMessage = null;
            this.lastUiPayloadKey = null;
            return false;
        }
    }

    public attachController(controller: QueuePlaybackController): void {
        if (this.controller && this.controller !== controller) {
            this.controller.destroy();
        }
        this.controller = controller;
    }

    public detachController(controller: QueuePlaybackController): void {
        if (this.controller === controller) this.controller = null;
    }

    public getController<T extends QueuePlaybackController>(): T | null {
        return this.controller as T | null;
    }

    public current(): Song | null {
        return this.songs[0] ?? null;
    }

    public peekNext(): Song | null {
        return this.songs[1] ?? null;
    }

    public add(song: Song): boolean {
        if (this.isDestroyed || this.songs.length >= this.maxSize || this.contains(song)) {
            return false;
        }

        this.registerSong(song);

        if (this.shuffle && this.songs.length > 0) {
            const insertIndex = 1 + Math.floor(Math.random() * this.songs.length);
            this.songs.splice(insertIndex, 0, song);
        } else {
            this.songs.push(song);
        }
        return true;
    }

    public addMany(songs: readonly Song[]): Song[] {
        if (this.isDestroyed || songs.length === 0) return [];

        const availableCapacity = this.maxSize - this.songs.length;
        if (availableCapacity <= 0) return [];

        const accepted: Song[] = [];
        const limit = Math.min(songs.length, availableCapacity);

        for (let i = 0; i < limit; i++) {
            const song = songs[i];
            if (!song || this.contains(song)) continue;

            this.registerSong(song);
            this.songs.push(song);
            accepted.push(song);
        }

        if (this.shuffle && this.songs.length > 1 && accepted.length > 0) {
            this.shuffleQueue();
        }

        return accepted;
    }

    public advance(): Song | null {
        const finished = this.songs.shift() ?? null;
        if (finished) {
            this.unregisterSong(finished);
        }

        this.currentIndex = 0;

        if (!finished) {
            this.currentSong = null;
            return null;
        }

        this.history.push(finished);
        if (this.history.length > DEFAULT_HISTORY_LIMIT) {
            this.history.shift();
        }

        if (this.skipTrackLoop) {
            this.skipTrackLoop = false;
        } else if (this.loopMode === "track") {
            this.songs.unshift(finished);
            this.registerSong(finished);
        } else if (this.loopMode === "queue") {
            this.songs.push(finished);
            this.registerSong(finished);
        }

        this.currentSong = this.songs[0] ?? null;
        return finished;
    }

    public setPlaying(state: boolean): void {
        this.currentSong = state ? (this.songs[0] ?? null) : null;
    }

    public isPlaying(): boolean {
        return this.player.state.status !== AudioPlayerStatus.Idle;
    }

    public setLifecycle(state: PlayerLifecycleState): void {
        if (this.isDestroyed && state !== "DESTROYED") return;
        if (this.lifecycle === state) return;
        this.lifecycle = state;
        this.emit("lifecycle", state);
    }

    public textChannel(client: GeckoClient): SendableTextChannel | null {
        const channel = client.channels.cache.get(this.textChannelId);
        return channel?.isTextBased() ? (channel as unknown as TextBasedChannel & SendableTextChannel) : null;
    }

    public startIdleTimeout(callback: () => void | Promise<void>, delayMs: number): void {
        if (this.isDestroyed) return;
        this.clearIdleTimeout();
        this.idleTimeout = setTimeout(() => {
            if (!this.isDestroyed) void callback();
        }, delayMs);
        this.idleTimeout.unref();
    }

    public clearIdleTimeout(): void {
        if (!this.idleTimeout) return;
        clearTimeout(this.idleTimeout);
        this.idleTimeout = null;
    }

    public async cleanupNowPlayingMessage(): Promise<void> {
        this.clearUiUpdateTimeout();
        this.lastUiPayloadKey = null;
        const message = this.nowPlayingMessage;
        this.nowPlayingMessage = null;
        if (!message) return;
        await message.delete().catch(() => undefined);
    }

    public setConnection(connection: VoiceConnection): void {
        if (this.connection === connection) return;

        if (this.connection) {
            this.connection.off("stateChange", this.onConnectionStateChange);
        }
        this.connection = connection;
        this.connection.on("stateChange", this.onConnectionStateChange);
        this.setLifecycle("CONNECTING");
    }

    public clearAll(): void {
        const removed = this.songs.splice(0);
        for (let i = 0; i < removed.length; i++) {
            this.unregisterSong(removed[i]);
        }
        this.history.length = 0;
        this.songSet.clear();
        this.currentSong = null;
    }

    public clearQueue(): void {
        if (this.songs.length > 1) {
            const removed = this.songs.splice(1);
            for (let i = 0; i < removed.length; i++) {
                this.unregisterSong(removed[i]);
            }
        }
    }

    public shuffleQueue(): void {
        if (this.songs.length <= 2) return;
        for (let index = this.songs.length - 1; index > 1; index -= 1) {
            const target = 1 + Math.floor(Math.random() * index);
            const temp = this.songs[index];
            this.songs[index] = this.songs[target];
            this.songs[target] = temp;
        }
        this.shuffle = true;
    }

    public remove(position: number): Song | null {
        const index = position - 1;
        if (index <= 0 || index >= this.songs.length) return null;
        const [removed] = this.songs.splice(index, 1);
        if (removed) {
            this.unregisterSong(removed);
        }
        return removed ?? null;
    }

    public move(from: number, to: number): boolean {
        const fromIndex = from - 1;
        const toIndex = to - 1;
        if (
            fromIndex <= 0 ||
            toIndex <= 0 ||
            fromIndex >= this.songs.length ||
            toIndex >= this.songs.length ||
            fromIndex === toIndex
        ) {
            return false;
        }
        const [song] = this.songs.splice(fromIndex, 1);
        if (!song) return false;
        this.songs.splice(toIndex, 0, song);
        return true;
    }

    public skip(): void {
        if (this.isDestroyed) return;
        if (this.controller && typeof this.controller.skip === "function") {
            this.controller.skip();
        } else {
            this.player.stop(true);
        }
    }

    public previous(): Song | null {
        if (this.isDestroyed || this.history.length === 0) return null;
        const prevSong = this.history.pop()!;
        this.registerSong(prevSong);

        this.songs.unshift(prevSong);
        this.currentSong = prevSong;

        if (this.loopMode === "track") {
            this.skipTrackLoop = true;
        }

        if (this.isPlaying()) {
            if (this.controller && typeof this.controller.skip === "function") {
                this.controller.skip(false);
            } else {
                this.player.stop(true);
            }
        } else {
            if (this.controller && typeof (this.controller as any).ensurePlayback === "function") {
                void (this.controller as any).ensurePlayback();
            }
        }
        return prevSong;
    }

    public stop(): void {
        if (this.isDestroyed) return;
        if (this.controller && typeof this.controller.stop === "function") {
            this.controller.stop();
        } else {
            this.clearAll();
            void this.cleanupNowPlayingMessage();
            this.player.stop(true);
        }
    }

    public destroy(): void {
        if (this.isDestroyed) return;
        this.isDestroyed = true;
        this.setLifecycle("DESTROYED");
        this.clearIdleTimeout();
        this.clearUiUpdateTimeout();

        if (this.controller) {
            const ctrl = this.controller;
            this.controller = null;
            ctrl.destroy();
        }

        this.songs.length = 0;
        this.history.length = 0;
        this.songSet.clear();
        this.currentSong = null;
        this.nowPlayingMessage = null;
        this.lastUiPayloadKey = null;
        this.queueUpdate = undefined;

        this.player.off("error", this.onPlayerError);
        try {
            this.player.stop(true);
        } catch {
        }

        if (this.connection) {
            this.connection.off("stateChange", this.onConnectionStateChange);
            if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try {
                    this.connection.destroy();
                } catch {
                }
            }
            this.connection = null;
        }

        this.removeAllListeners();
    }

    private contains(candidate: Song): boolean {
        if (candidate.id && this.songSet.has(candidate.id)) return true;
        if (candidate.canonicalUrl && this.songSet.has(candidate.canonicalUrl)) return true;
        return false;
    }

    private registerSong(song: Song): void {
        if (song.id) this.songSet.add(song.id);
        if (song.canonicalUrl) this.songSet.add(song.canonicalUrl);
    }

    private unregisterSong(song: Song): void {
        if (song.id) this.songSet.delete(song.id);
        if (song.canonicalUrl) this.songSet.delete(song.canonicalUrl);
    }

    private handlePlayerError(error: Error & { resource?: unknown }): void {
        if (!this.isDestroyed) this.emit("playerError", error);
    }

    private handleConnectionStateChange(
        _oldState: { status: VoiceConnectionStatus },
        newState: { status: VoiceConnectionStatus },
    ): void {
        if (!this.isDestroyed) this.emit("connectionStateChange", newState.status);
    }
}
