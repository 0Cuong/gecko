import {
    SlashCommandBuilder,
    PermissionsBitField,
    MessageFlags,
    GuildMember,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ComponentType,
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

async function safeEditReply(interaction: any, payload: any) {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
        }
    } catch (err) {
        console.error("[Interaction Reply Error]:", err);
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName("search")
        .setDescription("Search for music tracks and select one to play.")
        .addStringOption((o) =>
            o.setName("query").setDescription("Search query or keywords").setRequired(true),
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
        if (!guild) return;

        if (activeCommandLocks.has(guild.id)) {
            await interaction.reply({
                embeds: [embed("warn", "Another command is currently processing for this server. Please wait.")],
                flags: MessageFlags.Ephemeral,
            }).catch(() => null);
            return;
        }

        activeCommandLocks.add(guild.id);

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const rawQuery = interaction.options.getString("query", true).trim();
            const source = (interaction.options.getString("source") ?? "youtube") as "youtube" | "soundcloud";

            if (!rawQuery || rawQuery.length > 300 || rawQuery.includes("\u0000")) {
                await safeEditReply(interaction, {
                    embeds: [embed("error", "Please provide a valid search query shorter than 300 characters.")],
                });
                return;
            }

            const me: GuildMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null as any);
            if (!me) {
                await safeEditReply(interaction, { embeds: [embed("error", "Internal error resolving bot permissions.")] });
                return;
            }

            const member = interaction.member instanceof GuildMember 
                ? interaction.member 
                : await guild.members.fetch(interaction.user.id).catch(() => null);
            
            const voiceChannel = member?.voice?.channel;

            if (!voiceChannel) {
                await safeEditReply(interaction, {
                    embeds: [embed("warn", "You must be connected to a voice channel to search and play music.")],
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

            let searchResults: any[];
            try {
                const resolved = await resolve(rawQuery, { source, isUrl });
                searchResults = (Array.isArray(resolved) ? resolved : [resolved]).slice(0, 10);
            } catch (err) {
                await safeEditReply(interaction, {
                    embeds: [embed("error", err instanceof Error ? sanitizeUserErrorMessage(err) : "Failed to execute search.")],
                });
                return;
            }

            if (!searchResults || searchResults.length === 0) {
                await safeEditReply(interaction, { embeds: [embed("error", "No search results found.")] });
                return;
            }

            const options = searchResults.map((track, idx) => ({
                label: truncate(`${idx + 1}. ${track.title ?? "Unknown Title"}`, 100),
                description: truncate(`By ${track.author ?? "Unknown"} • ${formatDuration(track.duration ?? 0)}`, 100),
                value: String(idx),
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`search_select_${interaction.id}`)
                .setPlaceholder("Select a track to play...")
                .addOptions(options);

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

            const replyMessage = await interaction.editReply({
                embeds: [
                    embed("info", `Found **${searchResults.length}** results for \`${truncate(rawQuery, 50)}\`. Select a track below:`)
                ],
                components: [row],
            });

            const collector = replyMessage.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                time: 30_000,
                filter: (i: any) => i.user.id === interaction.user.id,
            });

            collector.on("collect", async (selectInteraction: any) => {
                await selectInteraction.deferUpdate();
                const selectedIdx = parseInt(selectInteraction.values[0], 10);
                const chosenTrack = searchResults[selectedIdx];

                if (!chosenTrack) {
                    await safeEditReply(interaction, { embeds: [embed("error", "Invalid selection.")], components: [] });
                    return;
                }

                const song: Song = buildSongFromTrack(chosenTrack, interaction.user.id, interaction.user.username);

                const voiceSessionManager = new VoiceSessionManager(client);
                let queue: GuildQueue;

                try {
                    queue = await voiceSessionManager.ensureQueueAndConnection(guild, voiceChannel, interaction.channelId);
                } catch (error) {
                    if (error instanceof VoiceSessionError) {
                        await safeEditReply(interaction, {
                            embeds: [embed(error.code === "ALREADY_ACTIVE" ? "warn" : "error", error.message)],
                            components: [],
                        });
                        return;
                    }
                    await safeEditReply(interaction, {
                        embeds: [embed("error", "Failed to join voice channel.")],
                        components: [],
                    });
                    return;
                }

                const shouldStartPlayback = !queue.isPlaying();
                const wasEmpty = queue.songs.length === 0;
                const acceptedSongs = queue.addMany([song]);

                if (acceptedSongs.length === 0) {
                    await safeEditReply(interaction, {
                        embeds: [embed("warn", "Track is already in queue or queue limit reached.")],
                        components: [],
                    });
                    return;
                }

                const durStr = song.isLive ? "Live" : formatDuration(song.duration);
                const responseEmbed = embed("success", `**[${truncate(song.title, 60)}](${song.webpageUrl})**`)
                    .setThumbnail(song.thumbnail || null)
                    .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined });

                if (wasEmpty) {
                    responseEmbed.setAuthor({ name: "Now Playing", iconURL: interaction.user.displayAvatarURL() })
                                 .addFields({ name: "Duration", value: `\`${durStr}\``, inline: true });
                } else {
                    responseEmbed.setAuthor({ name: "Added to Queue", iconURL: interaction.user.displayAvatarURL() })
                                 .addFields(
                                     { name: "Duration", value: `\`${durStr}\``, inline: true },
                                     { name: "Position in Queue", value: `\`#${queue.songs.length - 1}\``, inline: true }
                                 );
                }

                await safeEditReply(interaction, { embeds: [responseEmbed], components: [] });

                if (shouldStartPlayback) {
                    queue.suppressNowPlaying = true;
                    const targetQueue = queue;
                    setImmediate(() => {
                        if (targetQueue && !targetQueue.isDestroyed) {
                            play(client, guild.id)
                                .catch(e => console.error("[Playback Error]:", e))
                                .finally(() => { targetQueue.suppressNowPlaying = false; });
                        }
                    });
                }

                collector.stop("selected");
            });

            collector.on("end", async (_, reason) => {
                if (reason !== "selected") {
                    await safeEditReply(interaction, {
                        embeds: [embed("warn", "Search selection timed out.")],
                        components: [],
                    }).catch(() => null);
                }
            });

        } finally {
            activeCommandLocks.delete(guild.id);
        }
    },
} satisfies SlashCommand;
