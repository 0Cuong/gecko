import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { truncate } from "../utils/format.js";

export default {
    data: new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Skip the current song."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue || (!queue.current() && !queue.isPlaying() && queue.lifecycle !== "BUFFERING")) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Nothing is playing.")], flags: MessageFlags.Ephemeral });
            return;
        }

        const skipped = queue.current();

        await interaction.reply({
            embeds: [
                embed("success", `⏭️ Skipped **${truncate(skipped?.title ?? "current song", 60)}**.`),
            ],
        });

        queue.skip();
    },
} satisfies SlashCommand;
