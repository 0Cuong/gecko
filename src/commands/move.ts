import { MessageFlags,  
    SlashCommandBuilder, 
    ChatInputCommandInteraction, 
    GuildMember 
} from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";

export default {
    data: new SlashCommandBuilder()
        .setName("move")
        .setDescription("Move a track to a different position in the queue.")
        .addIntegerOption(option =>
            option.setName("track")
                .setDescription("Current position of the song to move (e.g. 3)")
                .setRequired(true)
                .setMinValue(2)
        )
        .addIntegerOption(option =>
            option.setName("position")
                .setDescription("New position to move the song to (e.g. 2)")
                .setRequired(true)
                .setMinValue(2)
        ),

    async execute(interaction: ChatInputCommandInteraction, client: any) {
        const guildId = interaction.guildId!;
        const queue = client.queues.get(guildId);

        if (!queue || queue.songs.length === 0) {
            await interaction.reply({ 
                embeds: [embed("warn", "⚠️ The queue is currently empty.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const member = interaction.member as GuildMember;
        const voiceChannel = member?.voice?.channel;
        
        // Ensure user is in the same voice channel as the bot
        if (!voiceChannel || !queue.connection || voiceChannel.id !== queue.connection.joinConfig.channelId) {
            await interaction.reply({
                embeds: [embed("error", "❌ You must be in the same voice channel as the bot to move tracks.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const trackPos = interaction.options.getInteger("track", true);
        const targetPos = interaction.options.getInteger("position", true);

        const currentPlayingPos = queue.currentIndex + 1;
        const maxPos = queue.songs.length;
        const minAllowedPos = currentPlayingPos + 1;

        if (trackPos < minAllowedPos || trackPos > maxPos) {
            await interaction.reply({
                embeds: [embed("error", `❌ Invalid track position. You can only move upcoming tracks between **#${minAllowedPos}** and **#${maxPos}**.`)],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (targetPos < minAllowedPos || targetPos > maxPos) {
            await interaction.reply({
                embeds: [embed("error", `❌ Invalid target position. You can only move to a position between **#${minAllowedPos}** and **#${maxPos}**.`)],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (trackPos === targetPos) {
            await interaction.reply({
                embeds: [embed("info", "ℹ️ That song is already at that position.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const trackToMove = queue.songs[trackPos - 1];
        if (!trackToMove) {
            await interaction.reply({
                embeds: [embed("error", "❌ Could not find the requested track in the queue.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const moved = queue.move(trackPos, targetPos);

        if (moved) {
            if (typeof queue.queueUpdate === "function") {
                queue.queueUpdate(client);
            }

            await interaction.reply({
                embeds: [embed("success", `↕️ Moved **[${trackToMove.title}](${trackToMove.webpageUrl})** from position **#${trackPos}** to **#${targetPos}**.`)]
            });
        } else {
            await interaction.reply({
                embeds: [embed("error", "❌ Failed to move track. Please check the positions and try again.")],
                flags: MessageFlags.Ephemeral
            });
        }
    }
} satisfies SlashCommand;
