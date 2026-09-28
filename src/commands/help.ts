import { MessageFlags,  ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";

export default {
    data: new SlashCommandBuilder()
        .setName("help")
        .setDescription("Display list of all supported commands."),

    async execute(interaction: ChatInputCommandInteraction) {
        try {
            const bannerUrl = "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExb3FjeXNweGZ5bWhlanJoODhqbm15c2xsYmd6dDhyYmdwYXBqa2thbCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/Q2FF3G90RNqoTgu5qC/giphy.gif";

            const helpEmbed = new EmbedBuilder()
                .setColor(0x10b981) // Emerald Green
                .setTitle("🦎 Gecko Music Bot")
                .setDescription("Minimal, fast, and stable Discord music engine.")
                .setImage(bannerUrl)
                .addFields(
                    {
                        name: "❯ Playback",
                        value: [
                            "`/play` - Play audio from YouTube, SoundCloud, or direct URL",
                            "`/pause` · `/resume` - Pause or resume current playback",
                            "`/stop` - Stop playback, clear the queue, and leave voice channel",
                            "`/skip` · `/previous` - Skip to next song or replay previous song",
                            "`/volume` - Adjust audio output volume (1-200%)"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Queue Management",
                        value: [
                            "`/queue` - View and interactively manage upcoming queue",
                            "`/nowplaying` - Display details and progress of current track",
                            "`/search` - Search tracks on YouTube/SoundCloud with selection menu",
                            "`/remove` - Remove a track from queue by position",
                            "`/clear` - Clear all upcoming songs from queue",
                            "`/move` - Move a song to a different position in queue"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Modes & Settings",
                        value: [
                            "`/loop` - Toggle repeat mode (off, track, queue)",
                            "`/shuffle` - Toggle shuffle mode for upcoming tracks",
                            "`/autoplay` - Automatically play related tracks when queue ends"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Voice & Diagnostics",
                        value: [
                            "`/join` - Join your current voice channel",
                            "`/leave` - Leave voice channel and stop playback",
                            "`/system` - View live engine health, memory, and diagnostics"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Credits & Support",
                        value: [
                            "**MCuong** (<@840850234560872468>)",
                            "**Gecko** (<@922429354116546610>)",
                        ].join("\n"),
                        inline: false
                    }
                )
                .setFooter({ text: "Gecko Music • Fast • Stable • Lightweight" });

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            console.error("[Gecko:Help] Error executing help command:", error);
        }
    },
} satisfies SlashCommand;