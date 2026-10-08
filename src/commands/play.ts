import {
    SlashCommandBuilder,
    PermissionsBitField,
    MessageFlags,
    GuildMember,
    type ChatInputCommandInteraction,
    type InteractionReplyOptions,
    type MessageEditOptions,
} from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { resolve } from "../sources/resolver.js";
import { embed } from "../utils/embeds.js";
import { formatDuration, truncate } from "../utils/format.js";
import { isHttpUrl } from "../utils/url.js";
import { VoiceSessionManager, VoiceSessionError } from "../player/VoiceSessionManager.js";
import { buildSongFromTrack, type Song } from "../queue/types.js";
import { GuildQueue } from "../queue/GuildQueue.js";
import { play } from "../player/play.js";
import { sanitizeUserErrorMessage } from "../utils/security.js";

const activeCommandLocks = new Set<string>();

async function safeEditReply(
    interaction: ChatInputCommandInteraction,
    payload: InteractionReplyOptions & MessageEditOptions,
) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch (err) {
        console.error("[Interaction Reply Error]:", err);
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song or playlist from YouTube, SoundCloud, or a direct URL.")
        .addStringOption((o) =>
            o.setName("query").setDescription("Song name, URL, or playlist URL").setRequired(true),
        )
        .addStringOption((o) =>
            o
                .setName("source")
                .setDescription("Search source (default: YouTube)")
                .addChoices(
                    { name: "YouTube", value: "youtube" },
                    { name: "SoundCloud", value: "soundcloud" },
                ),
        ),

    async execute(interaction, client) {
        const guild = interaction.guild;
        if (!guild) {
            await interaction.reply({ embeds: [embed("warn", "This command can only be used in a server.")], flags: MessageFlags.Ephemeral });
            return;
        }

        // Acknowledge before any lock, cache, member, resolver or voice work. Discord
        // invalidates an interaction after ~3 seconds, even when the work is valid.
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error(`[Music][Interaction] Failed to acknowledge /play guild=${guild.id}:`, error);
            return;
        }

        if (activeCommandLocks.has(guild.id)) {
            await safeEditReply(interaction, {
                embeds: [embed("warn", "Another command is currently processing for this server. Please wait.")],
            });
            return;
        }

        activeCommandLocks.add(guild.id);

        try {
            const rawQuery = interaction.options.getString("query", true).trim();
            const source = (interaction.options.getString("source") ?? "youtube") as "youtube" | "soundcloud";

            if (!rawQuery || rawQuery.length > 300 || rawQuery.includes("\u0000")) {
                await safeEditReply(interaction, {
                    embeds: [embed("error", "Please provide a valid search query shorter than 300 characters.")],
                });
                return;
            }

            const botUserId = client.user?.id;
            let me: GuildMember | null = guild.members.me;
            if (!me && botUserId) {
                me = guild.members.cache.get(botUserId) ?? null;
            }
            if (!me) {
                me = await guild.members.fetchMe().catch(() => null);
            }

            if (!me) {
                await safeEditReply(interaction, {
                    embeds: [embed("error", "Internal error resolving bot permissions.")],
                });
                return;
            }

            const member =
                interaction.member instanceof GuildMember
                    ? interaction.member
                    : await guild.members.fetch(interaction.user.id).catch(() => null);

            const voiceChannel = member?.voice?.channel;

            if (!voiceChannel) {
                await safeEditReply(interaction, {
                    embeds: [embed("warn", "You must be connected to a voice channel to play music.")],
                });
                return;
            }

            const permissions = voiceChannel.permissionsFor(me);
            if (
                !permissions ||
                !permissions.has(PermissionsBitField.Flags.ViewChannel) ||
                !permissions.has(PermissionsBitField.Flags.Connect) ||
                !permissions.has(PermissionsBitField.Flags.Speak)
            ) {
                await safeEditReply(interaction, {
                    embeds: [embed("error", "I need `ViewChannel`, `Connect`, and `Speak` permissions for that channel.")],
                });
                return;
            }

            const isUrl = isHttpUrl(rawQuery);
            const voiceSessionManager = new VoiceSessionManager(client);

            const resolvePromise = resolve(rawQuery, { source, isUrl }).catch((err) => err);
            const voicePromise = voiceSessionManager
                .ensureQueueAndConnection(guild, voiceChannel, interaction.channelId)
                .catch((err) => err);

            const [resolvedData, queueResult] = await Promise.all([resolvePromise, voicePromise]);

            if (resolvedData instanceof Error || !resolvedData) {
                await safeEditReply(interaction, {
                    embeds: [
                        embed(
                            "error",
                            resolvedData instanceof Error ? sanitizeUserErrorMessage(resolvedData) : "Error resolving query.",
                        ),
                    ],
                });
                return;
            }

            if (queueResult instanceof Error || !queueResult) {
                if (queueResult instanceof VoiceSessionError) {
                    await safeEditReply(interaction, {
                        embeds: [
                            embed(queueResult.code === "ALREADY_ACTIVE" ? "warn" : "error", queueResult.message),
                        ],
                    });
                    return;
                }
                console.error(`[Voice Join Error] Guild: ${guild.id}`, queueResult);
                await safeEditReply(interaction, {
                    embeds: [embed("error", "Failed to join the voice channel. Please try again.")],
                });
                return;
            }

            const queue: GuildQueue = queueResult;

            const rawTracks = (Array.isArray(resolvedData) ? resolvedData : [resolvedData]).slice(
                0,
                client.config.maxPlaylistSize,
            ) as any[];

            const songs: Song[] = rawTracks
                .map((track) => buildSongFromTrack(track, interaction.user.id, interaction.user.username))
                .filter((song) => song.canonicalUrl.length > 0);

            if (!songs || songs.length === 0) {
                await safeEditReply(interaction, { embeds: [embed("error", "No search results found.")] });
                return;
            }

            const shouldStartPlayback = !queue.isPlaying();
            const wasEmpty = queue.songs.length === 0;
            const acceptedSongs = queue.addMany(songs);

            if (acceptedSongs.length === 0) {
                await safeEditReply(interaction, {
                    embeds: [
                        embed("warn", "Those tracks are already in the queue or the queue has reached its limit."),
                    ],
                });
                return;
            }

            if (shouldStartPlayback) {
                queue.suppressNowPlaying = true;
                const targetQueue = queue;

                play(client, guild.id)
                    .catch((e) => console.error("[Playback Error]:", e))
                    .finally(() => {
                        if (targetQueue) targetQueue.suppressNowPlaying = false;
                    });
            }

            // Streams are intentionally resolved only JIT.  Prefetching direct CDN URLs risks expiry.

            if (acceptedSongs.length === 1) {
                const song = acceptedSongs[0];
                const durStr = song.isLive ? "Live" : formatDuration(song.duration);
                const displayUrl = song.webpageUrl;
                const displayTitle =
                    song.author && !song.title.toLowerCase().includes(song.author.toLowerCase())
                        ? `${song.title} - ${song.author}`
                        : song.title;

                const responseEmbed = embed("success", `**[${truncate(displayTitle, 70)}](${displayUrl})**`)
                    .setThumbnail(song.thumbnail || null)
                    .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined });

                if (wasEmpty) {
                    responseEmbed
                        .setAuthor({ name: "Now Playing", iconURL: interaction.user.displayAvatarURL() })
                        .addFields({ name: "Duration", value: `\`${durStr}\``, inline: true });
                } else {
                    responseEmbed
                        .setAuthor({ name: "Added to Queue", iconURL: interaction.user.displayAvatarURL() })
                        .addFields(
                            { name: "Duration", value: `\`${durStr}\``, inline: true },
                            { name: "Position in Queue", value: `\`#${queue.songs.length - 1}\``, inline: true },
                        );
                }
                await safeEditReply(interaction, { embeds: [responseEmbed] });
            } else {
                await safeEditReply(interaction, {
                    embeds: [
                        embed("success", `Successfully queued **${acceptedSongs.length}** tracks.`).setAuthor({
                            name: "Playlist Enqueued",
                            iconURL: interaction.user.displayAvatarURL(),
                        }),
                    ],
                });
            }
        } finally {
            activeCommandLocks.delete(guild.id);
        }
    },
} satisfies SlashCommand;
