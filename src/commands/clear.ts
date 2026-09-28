import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the queue (keeps the current song playing)."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue || queue.songs.length <= 1) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ The queue is already empty.")], flags: MessageFlags.Ephemeral });
            return;
        }
        const count = queue.songs.length - 1; // don't count current
        queue.clearQueue();
        await interaction.reply({
            embeds: [embed("success", `🗑️ Cleared **${count}** song${count !== 1 ? "s" : ""} from the queue.`)],
        });
    },
} satisfies SlashCommand;
