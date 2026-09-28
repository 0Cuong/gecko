import { VoiceConnectionStatus, getVoiceConnection } from "@discordjs/voice";
import { MessageFlags, SlashCommandBuilder, ChatInputCommandInteraction, PermissionsBitField } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { VoiceSessionManager, VoiceSessionError } from "../player/VoiceSessionManager.js";

export default {
    data: new SlashCommandBuilder()
        .setName("join")
        .setDescription("Join your current voice channel."),

    async execute(interaction: ChatInputCommandInteraction, client: GeckoClient) {
        const guild = interaction.guild;
        if (!guild) return;

        const member = (interaction.member as any) ?? guild.members.cache.get(interaction.user.id) ?? await guild.members.fetch(interaction.user.id);
        const voiceChannel = member?.voice?.channel;

        if (!voiceChannel) {
            await interaction.reply({ 
                embeds: [embed("warn", "⚠️ You need to be in a voice channel.")], 
                flags: MessageFlags.Ephemeral 
            });
            return;
        }

        const permissions = voiceChannel.permissionsFor(guild.members.me!);
        if (!permissions || !permissions.has(PermissionsBitField.Flags.ViewChannel) || !permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            await interaction.reply({
                embeds: [embed("error", "❌ I need `ViewChannel`, `Connect`, and `Speak` permissions for that channel.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const guildId = guild.id;
        const existingConnection = getVoiceConnection(guildId);
        let queue = client.queues.get(guildId);

        const isConnectionActive = existingConnection && 
                                   existingConnection.state.status !== VoiceConnectionStatus.Destroyed && 
                                   existingConnection.state.status !== VoiceConnectionStatus.Disconnected;

        if (isConnectionActive && queue && !queue.isDestroyed && queue.connection === existingConnection) {
            if (existingConnection.joinConfig.channelId === voiceChannel.id) {
                await interaction.reply({ 
                    embeds: [embed("info", "✅ Already in your voice channel.")],
                    flags: MessageFlags.Ephemeral
                });
                return;
            } else if (queue.isPlaying()) {
                await interaction.reply({ 
                    embeds: [embed("warn", "⚠️ I am currently active playing music in another voice channel.")],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
        }

        await interaction.deferReply();

        const voiceSessionManager = new VoiceSessionManager(client);
        try {
            await voiceSessionManager.ensureQueueAndConnection(guild, voiceChannel, interaction.channelId);
        } catch (error) {
            if (error instanceof VoiceSessionError) {
                await interaction.editReply({
                    embeds: [embed(error.code === "ALREADY_ACTIVE" ? "warn" : "error", error.message)],
                });
                return;
            }
            console.error("[Join Connection Error]", error);
            await interaction.editReply({
                embeds: [embed("error", "❌ Failed to establish voice connection.")],
            });
            return;
        }

        await interaction.editReply({
            embeds: [embed("success", `✅ Joined **${voiceChannel.name}** and subscribed audio player.`)],
        });
    },
} satisfies SlashCommand;