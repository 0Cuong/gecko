import {
    joinVoiceChannel,
    entersState,
    getVoiceConnection,
    VoiceConnectionStatus,
    type VoiceConnection
} from "@discordjs/voice";
import type { Guild, VoiceBasedChannel } from "discord.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { GuildQueue } from "../queue/GuildQueue.js";
import { logMusic } from "./MusicLogger.js";

export class VoiceSessionError extends Error {
    public readonly code: "ALREADY_ACTIVE" | "VOICE_JOIN_FAILED" | "VOICE_TIMEOUT" | "INVALID_QUERY";

    public constructor(message: string, code: "ALREADY_ACTIVE" | "VOICE_JOIN_FAILED" | "VOICE_TIMEOUT" | "INVALID_QUERY") {
        super(message);
        this.name = "VoiceSessionError";
        this.code = code;
    }
}

const VOICE_READY_TIMEOUT_MS = 4_000;

export class VoiceSessionManager {
    private static readonly inFlightJoins = new Map<string, Promise<GuildQueue>>();

    public constructor(private readonly client: GeckoClient) {}

    public async ensureQueueAndConnection(
        guild: Guild,
        voiceChannel: VoiceBasedChannel,
        textChannelId: string,
    ): Promise<GuildQueue> {
        const guildId = guild.id;

        const existingJoin = VoiceSessionManager.inFlightJoins.get(guildId);
        if (existingJoin) {
            return existingJoin;
        }

        const joinPromise = this.internalEnsureQueueAndConnection(guild, voiceChannel, textChannelId);
        VoiceSessionManager.inFlightJoins.set(guildId, joinPromise);

        try {
            return await joinPromise;
        } finally {
            VoiceSessionManager.inFlightJoins.delete(guildId);
        }
    }

    private async internalEnsureQueueAndConnection(
        guild: Guild,
        voiceChannel: VoiceBasedChannel,
        textChannelId: string,
    ): Promise<GuildQueue> {
        const guildId = guild.id;
        let connection = getVoiceConnection(guildId);
        let queue = this.client.queues.get(guildId);

        const isConnectionAlive = Boolean(
            connection &&
            connection.state.status !== VoiceConnectionStatus.Destroyed &&
            connection.state.status !== VoiceConnectionStatus.Disconnected
        );

        const isQueueAlive = Boolean(
            queue &&
            !queue.isDestroyed &&
            (queue.connection === connection || !queue.connection)
        );

        if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
            if (queue && !queue.isDestroyed && queue.isPlaying()) {
                throw new VoiceSessionError(
                    "I am already active in another voice channel.",
                    "ALREADY_ACTIVE",
                );
            }

            this.cleanupStaleSession(guildId, queue, connection);
            connection = undefined;
            queue = undefined;
        }

        if (!isConnectionAlive || !isQueueAlive) {
            if (queue) {
                queue.destroy();
                this.client.queues.delete(guildId);
                queue = undefined;
            }

            if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                destroyConnection(connection, guildId, "replace-stale-connection");
                connection = undefined;
            }
        }

        if (!queue) {
            queue = new GuildQueue(
                textChannelId,
                this.client.config.defaultVolume,
                this.client.config.maxQueueSize
            );
            this.client.queues.set(guildId, queue);
        }

        if (!connection) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true,
            });
            queue.setConnection(connection);
        } else {
            queue.setConnection(connection);
        }

        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
            } catch (error) {
                this.cleanupStaleSession(guildId, queue, connection);
                throw new VoiceSessionError(
                    "Failed to join the voice channel within the expected time.",
                    "VOICE_TIMEOUT"
                );
            }
        }

        if (queue.player) {
            connection.subscribe(queue.player);
        }

        return queue;
    }

    public destroySession(guildId: string): void {
        VoiceSessionManager.inFlightJoins.delete(guildId);
        const queue = this.client.queues.get(guildId);
        if (queue) {
            // Queue teardown detaches the controller's connection listener before
            // destroying VoiceConnection. Destroying the connection first makes a
            // deliberate /stop look like an unexpected voice failure.
            this.client.queues.delete(guildId);
            queue.destroy();
            return;
        }

        const connection = getVoiceConnection(guildId);
        if (connection) destroyConnection(connection, guildId, "destroy-session-orphan-connection");
    }

    private cleanupStaleSession(
        guildId: string,
        queue: GuildQueue | undefined,
        connection: VoiceConnection | undefined
    ): void {
        VoiceSessionManager.inFlightJoins.delete(guildId);
        if (queue && !queue.isDestroyed) {
            queue.destroy();
            this.client.queues.delete(guildId);
        }
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) destroyConnection(connection, guildId, "cleanup-stale-session");
    }
}

function destroyConnection(connection: VoiceConnection, guildId: string, operation: string): void {
    try {
        connection.destroy();
    } catch (error) {
        logMusic("WARN", {
            guildId,
            operation,
            errorType: "voice-cleanup",
            error: error instanceof Error ? error : new Error(String(error)),
        });
    }
}
