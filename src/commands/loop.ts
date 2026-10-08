import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import type { LoopMode } from "../queue/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Toggle the repeat mode for the queue."),

    async execute(interaction: ChatInputCommandInteraction, client: any) {
        const queue = client.queues.get(interaction.guildId!);
        if (!queue) {
            await interaction.reply({
                embeds: [embed("warn", "Nothing is playing currently.")],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const nextMode: LoopMode =
            queue.loopMode === "off" ? "queue" :
            queue.loopMode === "queue" ? "track" : "off";
        queue.loopMode = nextMode;

        if (typeof queue.queueUpdate === "function") {
            queue.queueUpdate(client);
        }

        const confirmationMessage = `Repeat mode has been set to: **${nextMode === "queue" ? "Queue repeat" : nextMode === "track" ? "Current track" : "Off"}**`;
        const responseEmbed = embed("success", confirmationMessage)
            .setAuthor({ name: "Playback Mode Updated" })
            .setFooter({ text: "Gecko Music • Settings Updated" });

        await interaction.reply({
            embeds: [responseEmbed],
            flags: MessageFlags.Ephemeral,
        });
    },
} satisfies SlashCommand;