import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("shuffle")
        .setDescription("Toggle shuffle mode for upcoming songs."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);

        if (!queue || !queue.current() || queue.songs.length <= 1) {
            await interaction.reply({
                embeds: [embed("warn", "⚠️ Not enough songs in the queue to shuffle.")],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (queue.shuffle) {
            queue.shuffle = false;
            await interaction.reply({
                embeds: [
                    embed(
                        "success",
                        "🔀 Shuffle mode **disabled**."
                    ),
                ],
            });
        } else {
            queue.shuffleQueue();
            await interaction.reply({
                embeds: [
                    embed(
                        "success",
                        "🔀 Shuffle mode **enabled**. Upcoming tracks have been randomized."
                    ),
                ],
            });
        }
    },
} satisfies SlashCommand;