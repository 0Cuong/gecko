import type { VoiceState } from "discord.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { embed } from "../utils/embeds.js";

const RECONNECT_ATTEMPTS = 3;

export default function voiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
    client: GeckoClient,
): void {
    const guildId = newState.guild.id;
    const queue = client.queues.get(guildId);

    if (!queue || queue.isDestroyed) return;

    const connection = queue.connection;
    if (!connection) return;

    const botId = client.user?.id;
    const userId = newState.id;

    if (botId && userId === botId) {
        if (!newState.channelId) {
            void queue.cleanupNowPlayingMessage().catch(() => {});
            queue.destroy();
            client.queues.delete(guildId);
            return;
        }
    }

    const voiceChannelId = (botId && userId === botId && newState.channelId)
        ? newState.channelId
        : (newState.guild.members.me?.voice?.channelId ?? connection.joinConfig.channelId ?? newState.channelId);
    if (!voiceChannelId) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId !== voiceChannelId && newChannelId !== voiceChannelId && oldChannelId !== connection.joinConfig.channelId) return;
    if (oldChannelId === newChannelId) return;

    const channel = newState.guild.channels.cache.get(voiceChannelId);
    if (!channel || !channel.isVoiceBased()) return;

    let hasHuman = false;
    for (const member of channel.members.values()) {
        if (!member.user.bot) {
            hasHuman = true;
            break;
        }
    }

    if (hasHuman) {
        queue.clearIdleTimeout();
    } else {
        queue.clearIdleTimeout();
        const timeoutMs = client.config?.emptyVoiceTimeout ?? client.config?.idleTimeout ?? 180_000;

        queue.startIdleTimeout(() => {
            if (queue.isDestroyed) return;

            let textChannel = null;
            try {
                textChannel = queue.textChannel(client);
            } catch {
                textChannel = null;
            }

            void queue.cleanupNowPlayingMessage().catch(() => {});
            queue.destroy();
            client.queues.delete(guildId);

            if (textChannel) {
                void textChannel
                    .send({
                        embeds: [
                            embed(
                                "info",
                                "Voice channel became empty. I left the room and cleared the queue.",
                            ),
                        ],
                    })
                    .catch(() => {});
            }
        }, timeoutMs);
    }
}