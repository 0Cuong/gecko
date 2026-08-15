import { MessageFlags,  SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("autoplay")
        .setDescription("Toggle autoplay — automatically queues related songs when the queue ends."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue) {
            await interaction.reply({ embeds: [embed("warn", "⚠️ Nothing is playing.")], flags: MessageFlags.Ephemeral });
            return;
        }
        queue.autoplay = !queue.autoplay;
        const state = queue.autoplay ? "**on** ♾️" : "**off**";
        await interaction.reply({ embeds: [embed("success", `Autoplay is now ${state}.`)] });
    },
} satisfies SlashCommand;

