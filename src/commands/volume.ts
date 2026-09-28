import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

const MAX_SAFE_VOLUME_PERCENT = 200;

export default {
    data: new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Set volume level (1-200%).")
        .addIntegerOption((o) =>
            o
                .setName("level")
                .setDescription("Volume percentage level (1 = 1%, 100 = 100%, 200 = 200%)")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(MAX_SAFE_VOLUME_PERCENT),
        ),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue) {
            await interaction.reply({
                embeds: [embed("warn", "⚠️ Nothing is playing.")],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const level = interaction.options.getInteger("level", true);

        // Strict safety input validation
        if (!Number.isFinite(level) || level <= 0 || !Number.isSafeInteger(level) || level > MAX_SAFE_VOLUME_PERCENT) {
            await interaction.reply({
                embeds: [embed("error", "❌ Invalid volume level. Choose a value between 1 and 200.")],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const newVolume = queue.setVolume(level);
        const percentageDisplay = Math.round(newVolume * 100);
        await interaction.reply({
            embeds: [embed("success", `🔊 Volume set to **${percentageDisplay}%**.`)]
        });
    },
} satisfies SlashCommand;
