import type { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from "discord.js";
import type { GeckoClient } from "./GeckoClient.js";

export interface SlashCommand {
    data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">;
    execute(interaction: ChatInputCommandInteraction, client: GeckoClient): Promise<void>;
}
