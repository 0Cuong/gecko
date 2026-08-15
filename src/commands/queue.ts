// src/commands/queue.ts

import { MessageFlags,  
    SlashCommandBuilder, 
    ChatInputCommandInteraction, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    GuildMember,
    EmbedBuilder
} from "discord.js";
import type { SlashCommand } from "../client/types.js";
import { embed } from "../utils/embeds.js";
import { truncate, formatDuration } from "../utils/format.js";

// ========================================================
// 1. QUẢN LÝ TRẠNG THÁI CÔ LẬP THEO TỪNG NGƯỜI DÙNG (STATE)
// ========================================================

class QueueStateManager {
    private states = new Map<string, number | null>();

    private makeKey(guildId: string, userId: string): string {
        return `${guildId}:${userId}`;
    }

    public get(guildId: string, userId: string): number | null {
        return this.states.get(this.makeKey(guildId, userId)) ?? null;
    }

    public set(guildId: string, userId: string, index: number | null): void {
        this.states.set(this.makeKey(guildId, userId), index);
    }

    public delete(guildId: string, userId: string): void {
        this.states.delete(this.makeKey(guildId, userId));
    }
}

const queueState = new QueueStateManager();

// ========================================================
// 2. CÁC PHƯƠNG THỨC TRỢ GIÚP CHUẨN HÓA INDEX & VẼ GIAO DIỆN
// ========================================================

/**
 * Ánh xạ chỉ mục mảng 0-based (trong songs) thành 1-based (cho các phương thức của GuildQueue)
 */
function normalizeIndex(zeroBasedIndex: number): number {
    return zeroBasedIndex + 1;
}

/**
 * Xây dựng giao diện danh sách hàng đợi tối giản phong cách Spotify
 */
function generateQueueEmbed(queue: any, selectedIndex: number | null): EmbedBuilder {
    const current = queue.current();
    if (!current) {
        return embed("info", "The queue is currently empty.");
    }

    let description = `**Now Playing**\n01. [${truncate(current.title, 60)}](${current.webpageUrl})\n\n`;

    const upcoming = queue.songs.slice(1);
    
    if (upcoming.length > 0) {
        description += `**Queue**\n`;
        
        const listText = upcoming
            .slice(0, 10)
            .map((song: any, i: number) => {
                const queuePosition = i + 2;
                const isSelected = selectedIndex === queuePosition;
                const prefix = isSelected ? "» " : "  ";
                const line = `${prefix}${queuePosition}. [${truncate(song.title, 55)}](${song.webpageUrl})`;
                return isSelected ? `**${line}**` : line;
            })
            .join("\n");

        description += listText;

        if (upcoming.length > 10) {
            description += `\n\n*and ${upcoming.length - 10} more tracks...*`;
        }
    } else {
        description += `*No upcoming songs in queue. Use /play to add more.*`;
    }

    const totalDuration = queue.songs
        .filter((s: any) => !s.isLive)
        .reduce((acc: number, s: any) => acc + s.duration, 0);

    const embedObj = embed("success", description)
        .setAuthor({ name: "GECKO QUEUE" });

    const selectedText = selectedIndex !== null ? `#${selectedIndex}` : "None";
    
    embedObj.setFooter({ 
        text: `Tracks: ${queue.songs.length} | Selected Track: ${selectedText} | Total: ${formatDuration(totalDuration)} | Loop: ${queue.loopMode} | Shuffle: ${queue.shuffle ? "on" : "off"}` 
    });

    return embedObj;
}

/**
 * Sinh các Action Row chứa Select Menu và Button tương tác
 */
function generateQueueComponents(queue: any, selectedIndex: number | null): ActionRowBuilder<any>[] {
    const components: ActionRowBuilder<any>[] = [];
    
    // Fallback currentIndex về 0 nếu bị lỗi/âm
    const upcoming = queue.songs.slice(1);

    if (upcoming.length === 0) return [];

    // 1. Tạo Select Menu liệt kê tối đa 25 bài hát tiếp theo với Value Unique tuyệt đối
    const usedValues = new Set<string>();
    const selectOptions = [];

    for (let i = 0; i < upcoming.length; i++) {
        const song = upcoming[i];
        const queuePosition = i + 2;
        
        // Format unique: queue_track_{queuePosition}_{i}
        const uniqueValue = `queue_track_${queuePosition}_${i}`;

        // Bỏ qua nếu value đã tồn tại (phòng hờ)
        if (usedValues.has(uniqueValue)) continue;
        usedValues.add(uniqueValue);

        selectOptions.push({
            label: `${queuePosition}. ${truncate(song.title, 80)}`,
            description: song.author ? `By ${truncate(song.author, 40)}` : "Unknown Artist",
            value: uniqueValue,
            default: selectedIndex === queuePosition,
        });

        // Giới hạn tối đa 25 options theo Discord API
        if (selectOptions.length >= 25) break;
    }

    if (selectOptions.length === 0) return [];

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("queue_track_select")
        .setPlaceholder("Select a track to manage...")
        .addOptions(selectOptions);

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

    // Xác định phạm vi bài hát được chọn
    const safeCurrentPosition = 1;
    const hasSelected = selectedIndex !== null && 
                        selectedIndex > safeCurrentPosition && 
                        selectedIndex <= queue.songs.length;

    // Row 1: Các thao tác di chuyển vị trí tương đối
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("queue_move_up")
            .setLabel("Move Up")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasSelected || selectedIndex === safeCurrentPosition + 1),
        new ButtonBuilder()
            .setCustomId("queue_move_down")
            .setLabel("Move Down")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasSelected || selectedIndex === queue.songs.length),
        new ButtonBuilder()
            .setCustomId("queue_move_top")
            .setLabel("Move Top")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasSelected || selectedIndex === safeCurrentPosition + 1),
        new ButtonBuilder()
            .setCustomId("queue_move_bottom")
            .setLabel("Move Bottom")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasSelected || selectedIndex === queue.songs.length)
    );

    // Row 2: Thao tác ưu tiên phát và loại bỏ bài hát
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("queue_play_next")
            .setLabel("Play Next")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!hasSelected || selectedIndex === safeCurrentPosition + 1),
        new ButtonBuilder()
            .setCustomId("queue_remove")
            .setLabel("Remove")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasSelected)
    );

    components.push(row1, row2);
    return components;
}

/**
 * Tạo phiên bản vô hiệu hóa (Disabled) của các Component khi hết hạn bộ thu thập
 */
function generateDisabledComponents(components: ActionRowBuilder<any>[]): ActionRowBuilder<any>[] {
    return components.map(row => {
        const updatedRow = new ActionRowBuilder<any>();
        row.components.forEach(comp => {
            const json = comp.toJSON() as any;
            json.disabled = true;
            if (json.type === 3) { // StringSelectMenu
                updatedRow.addComponents(new StringSelectMenuBuilder(json));
            } else if (json.type === 2) { // Button
                updatedRow.addComponents(new ButtonBuilder(json));
            }
        });
        return updatedRow;
    });
}

// ========================================================
// 3. TRIỂN KHAI LỆNH SLASH COMMAND
// ========================================================

export default {
    data: new SlashCommandBuilder()
        .setName("queue")
        .setDescription("View and manage the upcoming music queue."),

    async execute(interaction: ChatInputCommandInteraction, client: any) {
        const guildId = interaction.guildId!;
        const userId = interaction.user.id;
        const queue = client.queues.get(guildId);

        if (!queue || queue.songs.length === 0) {
            await interaction.reply({ 
                embeds: [embed("info", "The queue is currently empty.")],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Thiết lập trạng thái rỗng cho người dùng hiện hành khi khởi chạy lệnh mới
        queueState.set(guildId, userId, null);

        const response = await interaction.reply({
            embeds: [generateQueueEmbed(queue, null)],
            components: generateQueueComponents(queue, null),
            fetchReply: true // Bắt buộc để thiết lập Collector cục bộ trên tin nhắn phản hồi
        });

        if (!response) return;

        // Bộ thu thập tương tác cục bộ hoạt động trong 5 phút (300.000 ms)
        const collector = response.createMessageComponentCollector({
            filter: (i) => i.customId.startsWith("queue_"),
            time: 300000, 
        });

        collector.on("collect", async (i: any) => {
            const member = i.member as GuildMember;
            const voiceChannel = member?.voice?.channel;
            
            // Xác thực phân quyền kênh thoại (Chỉ người dùng ở chung kênh voice mới được thao tác)
            if (!voiceChannel || !queue.connection || voiceChannel.id !== queue.connection.joinConfig.channelId) {
                await i.reply({
                    content: "You must be in the same voice channel.",
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const currentSelectedIndex = queueState.get(guildId, userId);

            // 1. Ghi nhận thao tác chọn bài hát từ Select Menu
            if (i.isStringSelectMenu() && i.customId === "queue_track_select") {
                // Parser an toàn: Lấy queue position từ format queue_track_{position}_{i}
                const selectedVal = Number(i.values[0].split("_")[2]);
                if (!isNaN(selectedVal) && selectedVal > 1) {
                    queueState.set(guildId, userId, selectedVal);
                }
            }

            // 2. Thao tác điều hướng bằng Buttons
            if (i.isButton() && currentSelectedIndex !== null) {
                const position = currentSelectedIndex;
                const safeCurrentIndex = Math.max(0, queue.currentIndex || 0);
                const safeCurrentPosition = safeCurrentIndex + 1;

                switch (i.customId) {
                    case "queue_move_up": {
                        if (position > safeCurrentPosition + 1 && position <= queue.songs.length) {
                            const from = position;
                            const to = position - 1;
                            if (queue.move(from, to)) {
                                queueState.set(guildId, userId, position - 1);
                            }
                        }
                        break;
                    }

                    case "queue_move_down": {
                        if (position > safeCurrentPosition && position < queue.songs.length) {
                            const from = position;
                            const to = position + 1;
                            if (queue.move(from, to)) {
                                queueState.set(guildId, userId, position + 1);
                            }
                        }
                        break;
                    }

                    case "queue_move_top":
                    case "queue_play_next": {
                        if (position > safeCurrentPosition + 1 && position <= queue.songs.length) {
                            const from = position;
                            const to = safeCurrentPosition + 1;
                            if (queue.move(from, to)) {
                                queueState.set(guildId, userId, safeCurrentPosition + 1);
                            }
                        }
                        break;
                    }

                    case "queue_move_bottom": {
                        if (position > safeCurrentPosition && position < queue.songs.length) {
                            const from = position;
                            const to = queue.songs.length;
                            if (queue.move(from, to)) {
                                queueState.set(guildId, userId, queue.songs.length);
                            }
                        }
                        break;
                    }

                    case "queue_remove": {
                        const removed = queue.remove(position);
                        if (removed) {
                            queueState.set(guildId, userId, null);
                        }
                        break;
                    }
                }

                // Cập nhật lại giao diện phát nhạc nền nếu cấu trúc hàng đợi thay đổi
                if (typeof queue.queueUpdate === "function") {
                    queue.queueUpdate(client);
                }
            }

            const updatedSelectedIndex = queueState.get(guildId, userId);

            // Cập nhật lại giao diện tại chỗ bằng i.update()
            await i.update({
                embeds: [generateQueueEmbed(queue, updatedSelectedIndex)],
                components: generateQueueComponents(queue, updatedSelectedIndex)
            });
        });

        // Khi hết hạn, tự động vô hiệu hóa các component thay vì xóa để bảo toàn tính thẩm mỹ của tin nhắn
        collector.on("end", () => {
            const lastSelection = queueState.get(guildId, userId);
            queueState.delete(guildId, userId);
            try {
                const activeComponents = generateQueueComponents(queue, lastSelection);
                const disabledComponents = generateDisabledComponents(activeComponents);
                
                response.edit({
                    components: disabledComponents
                });
            } catch {}
        });
    },
} satisfies SlashCommand;
