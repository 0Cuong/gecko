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
        .setDescription("Di chuyển vị trí của một bài hát trong hàng đợi.")
        .addIntegerOption(option =>
            option.setName("track")
                .setDescription("Vị trí hiện tại của bài hát muốn di chuyển (ví dụ: 3)")
                .setRequired(true)
                .setMinValue(2)
        )
        .addIntegerOption(option =>
            option.setName("position")
                .setDescription("Vị trí mới muốn chuyển đến (ví dụ: 2)")
                .setRequired(true)
                .setMinValue(2)
        ),

    async execute(interaction: ChatInputCommandInteraction, client: any) {
        const guildId = interaction.guildId!;
        const queue = client.queues.get(guildId);

        if (!queue || queue.songs.length === 0) {
            await interaction.reply({ 
                embeds: [embed("info", "Hàng đợi hiện đang trống.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const member = interaction.member as GuildMember;
        const voiceChannel = member?.voice?.channel;
        
        // Xác thực người dùng có ở cùng kênh thoại với Bot hay không
        if (!voiceChannel || !queue.connection || voiceChannel.id !== queue.connection.joinConfig.channelId) {
            await interaction.reply({
                embeds: [embed("error", "Bạn phải ở cùng kênh thoại với Bot để thực hiện lệnh này.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const trackPos = interaction.options.getInteger("track", true);
        const targetPos = interaction.options.getInteger("position", true);

        // Bài hát đang phát (currentIndex) có vị trí 1-based là currentIndex + 1
        const currentPlayingPos = queue.currentIndex + 1;
        const maxPos = queue.songs.length;

        // Chỉ cho phép di chuyển các bài hát nằm trong danh sách chờ (bắt đầu từ vị trí kế tiếp bài đang phát)
        const minAllowedPos = currentPlayingPos + 1;

        if (trackPos < minAllowedPos || trackPos > maxPos) {
            await interaction.reply({
                embeds: [embed("error", `Vị trí bài hát không hợp lệ. Bạn chỉ có thể chọn bài hát chờ từ vị trí **${minAllowedPos}** đến **${maxPos}**.`)],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (targetPos < minAllowedPos || targetPos > maxPos) {
            await interaction.reply({
                embeds: [embed("error", `Vị trí đích không hợp lệ. Bạn chỉ có thể chuyển bài hát tới vị trí chờ từ **${minAllowedPos}** đến **${maxPos}**.`)],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (trackPos === targetPos) {
            await interaction.reply({
                embeds: [embed("info", "Bài hát đã ở sẵn vị trí này rồi.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const trackToMove = queue.songs[trackPos - 1];
        if (!trackToMove) {
            await interaction.reply({
                embeds: [embed("error", "Không tìm thấy bài hát yêu cầu.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Thực hiện di chuyển vị trí bài hát (sử dụng 1-based index)
        const moved = queue.move(trackPos, targetPos);

        if (moved) {
            // Cập nhật lại trình phát nhạc nền nếu hàng đợi thay đổi cấu trúc
            if (typeof queue.queueUpdate === "function") {
                queue.queueUpdate(client);
            }

            await interaction.reply({
                embeds: [embed("success", `Đã di chuyển bài hát **[${trackToMove.title}](${trackToMove.webpageUrl})** từ vị trí **#${trackPos}** sang **#${targetPos}**.`)]
            });
        } else {
            await interaction.reply({
                embeds: [embed("error", "Không thể di chuyển bài hát. Vui lòng kiểm tra lại.")],
                flags: MessageFlags.Ephemeral
            });
        }
    }
} satisfies SlashCommand;
