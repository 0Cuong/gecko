import { MessageFlags,  SlashCommandBuilder } from "discord.js";
import { getVoiceConnection } from "@discordjs/voice";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { VoiceSessionManager } from "../player/VoiceSessionManager.js";

export default {
    data: new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop playback, clear the queue, and leave the voice channel."),

    async execute(interaction, client) {
        const guildId = interaction.guildId!;
        const queue = client.queues.get(guildId);
        const connection = getVoiceConnection(guildId);

        if (!queue && !connection) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Nothing is playing.")], flags: MessageFlags.Ephemeral });
            return;
        }

        const sessionManager = new VoiceSessionManager(client);
        try {
            sessionManager.destroySession(guildId);
        } catch (err) {
            console.error("[Stop] Error destroying playback session:", err);
        }

        await interaction.reply({
            embeds: [embed("success", "⏹️ Stopped playback, cleared the queue, and left the voice channel.")],
        });
    },
} satisfies SlashCommand;