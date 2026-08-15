import { MessageFlags, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { formatDuration } from "../utils/format.js";

export default {
    data: new SlashCommandBuilder()
        .setName("nowplaying")
        .setDescription("Show what's currently playing."),

    async execute(interaction, client) {
        const queue = client.queues.get(interaction.guildId!);
        
        const song = queue?.current();

        if (!queue || !song) {
            await interaction.reply({ 
                embeds: [embed("info", "📭 Nothing is playing.")], 
                flags: MessageFlags.Ephemeral 
            });
            return;
        }

        let loopStatus = "Off";
        if (queue.loopMode === "track") loopStatus = "Track 🔂";
        else if (queue.loopMode === "queue") loopStatus = "Queue 🔁";

        const songAny = song as any;
        const requestedBy = song.requester
            || (song.requesterId ? `<@${song.requesterId}>` : null)
            || songAny.requestedBy
            || (songAny.requestedById ? `<@${songAny.requestedById}>` : "Unknown");

        const songCount = queue.songs?.length ?? 0;

        const npEmbed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🎵 Now Playing")
            .setDescription(`[${song.title}](${song.webpageUrl})`)
            .addFields(
                { name: "Duration", value: song.isLive ? "🔴 LIVE" : formatDuration(song.duration), inline: true },
                { name: "Requested by", value: requestedBy, inline: true },
                { name: "Volume", value: `${queue.volume ?? 100}%`, inline: true },
                { name: "Loop", value: loopStatus, inline: true },
                { name: "Shuffle", value: queue.shuffle ? "on" : "off", inline: true },
                { name: "Queue", value: `${songCount} song${songCount !== 1 ? "s" : ""}`, inline: true },
            );

        if (song.thumbnail) {
            npEmbed.setThumbnail(song.thumbnail);
        }

        await interaction.reply({ embeds: [npEmbed] });
    },
} satisfies SlashCommand;
