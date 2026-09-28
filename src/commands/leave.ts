import { MessageFlags,  SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { getVoiceConnection } from "@discordjs/voice";
import { VoiceSessionManager } from "../player/VoiceSessionManager.js";

export default {
    data: new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Leave the voice channel and stop playback."),

    async execute(interaction, client) {
        const guildId = interaction.guildId!;
        const queue = client.queues.get(guildId);
        const connection = getVoiceConnection(guildId);

        if (!queue && !connection) {
            await interaction.reply({
                embeds: [
                    embed(
                        "warn",
                        "⚠️ I'm not connected to a voice channel."
                    )
                ],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const sessionManager = new VoiceSessionManager(client);
        try {
            sessionManager.destroySession(guildId);
        } catch (err) {
            console.error("[Leave] Error destroying playback session:", err);
        }

        await interaction.reply({
            embeds: [
                embed(
                    "success",
                    "👋 Left the voice channel and stopped playback."
                )
            ],
        });
    },
} satisfies SlashCommand;