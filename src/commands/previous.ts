import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { truncate } from "../utils/format.js";
import { play } from "../player/play.js";

export default {
    data: new SlashCommandBuilder()
        .setName("previous")
        .setDescription("Play the previous song from history."),

    async execute(interaction, client) {
        const guildId = interaction.guildId!;
        const queue = client.queues.get(guildId);
        if (!queue) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Nothing is playing.")], flags: MessageFlags.Ephemeral });
            return;
        }

        const prevSong = queue.previous();
        if (!prevSong) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ No previous song in history.")], flags: MessageFlags.Ephemeral });
            return;
        }

        await interaction.reply({
            embeds: [embed("success", `⏮️ Playing previous song: **${truncate(prevSong.title, 60)}**.`)]
        });

        if (!queue.isPlaying()) {
            await play(client, guildId);
        }
    },
} satisfies SlashCommand;
