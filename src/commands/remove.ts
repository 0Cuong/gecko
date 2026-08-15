import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { truncate } from "../utils/format.js";

export default {
    data: new SlashCommandBuilder()
        .setName("remove")
        .setDescription("Remove a song from the queue by its position.")
        .addIntegerOption((o) =>
            o
                .setName("position")
                .setDescription("Position in the queue (use /queue to see positions)")
                .setRequired(true)
                .setMinValue(2),
        ),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue || queue.songs.length === 0) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ The queue is empty.")], flags: MessageFlags.Ephemeral });
            return;
        }
        const pos = interaction.options.getInteger("position", true);
        if (pos === 1) {
            await interaction.reply({
                embeds: [embed("warn", "⚠️ Position 1 is the currently playing song. Use `/skip` to skip it.")],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        const removed = queue.remove(pos);
        if (!removed) {
            await interaction.reply({
                embeds: [embed("warn", `⚠️ No song at position ${pos}.`)],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        await interaction.reply({
            embeds: [embed("success", `🗑️ Removed **${truncate(removed.title, 60)}** from the queue.`)],
        });
    },
} satisfies SlashCommand;
