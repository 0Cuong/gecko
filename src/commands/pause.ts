import { AudioPlayerStatus } from "@discordjs/voice";
import { MessageFlags,  SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Pause the current song."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue || !queue.isPlaying()) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Nothing is playing.")], flags: MessageFlags.Ephemeral });
            return;
        }
        if (queue.player.state.status === AudioPlayerStatus.Paused) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Already paused.")], flags: MessageFlags.Ephemeral });
            return;
        }
        queue.player.pause();
        await interaction.reply({ embeds: [embed("success", "⏸️ Paused.")] });
    },
} satisfies SlashCommand;
