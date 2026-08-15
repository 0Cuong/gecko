import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { truncate } from "../utils/format.js";

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

        const prevSong = queue.history.pop();
        if (!prevSong) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ No previous song in history.")], flags: MessageFlags.Ephemeral });
            return;
        }

        // Insert previous song right after current song (position 1 in array)
        // so when player.stop() triggers advance(), current song moves to history
        // and prevSong becomes the new current song (position 0).
        queue.songs.splice(1, 0, prevSong);

        if (queue.loopMode === "track") {
            queue.skipTrackLoop = true;
        }

        await interaction.reply({
            embeds: [embed("success", `⏮️ Playing previous song: **${truncate(prevSong.title, 60)}**.`)]
        });

        queue.player.stop(true);
    },
} satisfies SlashCommand;
