import { MessageFlags,  ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../client/types.js";

export default {
    data: new SlashCommandBuilder()
        .setName("help")
        .setDescription("Hiển thị danh sách tất cả các lệnh hỗ trợ."),

    async execute(interaction: ChatInputCommandInteraction) {
        try {
            const bannerUrl = "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExb3FjeXNweGZ5bWhlanJoODhqbm15c2xsYmd6dDhyYmdwYXBqa2thbCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/Q2FF3G90RNqoTgu5qC/giphy.gif";

            const helpEmbed = new EmbedBuilder()
                .setColor(0x10b981) // Emerald Green
                .setTitle("Gecko Music")
                .setDescription("Trình phát nhạc cho Discord.")
                .setImage(bannerUrl)
                .addFields(
                    {
                        name: "❯ Trình phát",
                        value: [
                            "`/play` — Phát nhạc từ YouTube, SoundCloud hoặc liên kết trực tiếp",
                            "`/pause` · `/resume` — Tạm dừng hoặc tiếp tục phát nhạc",
                            "`/stop` — Dừng phát nhạc và xóa sạch hàng chờ",
                            "`/skip` · `/previous` — Chuyển tiếp hoặc quay lại bài hát trước đó",
                            "`/volume` — Điều chỉnh âm lượng đầu ra (1-100)"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Hàng chờ",
                        value: [
                            "`/queue` — Hiển thị danh sách các bài hát đang chờ phát",
                            "`/nowplaying` — Xem thông tin chi tiết bài hát đang phát",
                            "`/search` — Tìm kiếm và chọn bài phát theo yêu cầu",
                            "`/remove` — Xóa bài hát khỏi hàng chờ theo vị trí",                            
                            "`/clear` — Làm trống toàn bộ hàng chờ hiện tại",
                            "`/move` — Chuyển một bài hát đến vị trí khác trong hàng chờ"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Chế độ phát",
                        value: [
                            "`/loop` — Thiết lập chế độ lặp (tắt, bài hát, hàng chờ,loop 2 lần để tắt/mở",
                            "`/shuffle` — Bật hoặc tắt chế độ phát ngẫu nhiên",
                            "`/autoplay` — Tự động phát nhạc liên quan khi hết hàng chờ"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Kênh thoại",
                        value: [
                            "`/join` — Tham gia kênh thoại hiện tại của bạn",
                            "`/leave` — Rời khỏi kênh thoại và dừng phát nhạc"
                        ].join("\n"),
                        inline: false
                    },
                    {
                        name: "❯ Liên Hệ (nếu có vấn đề)",
                        value: [
                            "**MCuong** (<@840850234560872468>)",
                            "**Gecko** (<@922429354116546610>)",
                        ].join("\n"),
                        inline: false
                    }
                )
                .setFooter({ text: "Gecko Music • MCuong & Gecko" });

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            console.error("Lỗi xảy ra khi xử lý lệnh help:", error);
        }
    },
} satisfies SlashCommand;