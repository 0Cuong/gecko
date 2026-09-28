import { EmbedBuilder } from "discord.js";

const COLOR_MAP = {
    info: 0x5865f2,   // Blurple
    success: 0x57f287, // Green
    warn: 0xfee75c,   // Yellow
    error: 0xed4245,  // Red
} as const;

export function embed(
    type: keyof typeof COLOR_MAP,
    description: string,
): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLOR_MAP[type])
        .setDescription(description);
}
