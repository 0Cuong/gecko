import { AudioPlayerStatus } from "@discordjs/voice";
import { MessageFlags,  SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Resume the paused song."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Nothing is playing.")], flags: MessageFlags.Ephemeral });
            return;
        }
        if (queue.player.state.status !== AudioPlayerStatus.Paused && queue.player.state.status !== AudioPlayerStatus.AutoPaused) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Not paused.")], flags: MessageFlags.Ephemeral });
            return;
        }
        queue.player.unpause();
        await interaction.reply({ embeds: [embed("success", "▶️ Resumed.")] });
    },
} satisfies SlashCommand;
