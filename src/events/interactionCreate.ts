import { MessageFlags, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { embed } from "../utils/embeds.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { securityManager } from "../utils/security.js";

const DM_SCOPE = "DM";

export default async function interactionCreate(
    interaction: Interaction,
    client: GeckoClient,
): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    const cooldown = securityManager.checkCooldown(
        interaction.user.id,
        interaction.commandName,
        undefined,
        interaction.guildId ?? DM_SCOPE,
    );

    if (cooldown.onCooldown) {
        if (interaction.isRepliable()) {
            const remainingSec = Math.ceil(cooldown.remainingMs / 1_000);
            try {
                await interaction.reply({
                    embeds: [embed("warn", `⏳ Please wait ${remainingSec} second(s) before retrying this command.`)],
                    flags: MessageFlags.Ephemeral,
                });
            } catch (error) {
                console.error(`[Music][Interaction] Cooldown reply failed command=${interaction.commandName} guild=${interaction.guildId ?? DM_SCOPE}:`, error);
            }
        }
        return;
    }

    try {
        await command.execute(interaction, client);
    } catch (err) {
        console.error(`[Music][Interaction] Command failed command=${interaction.commandName} guild=${interaction.guildId ?? DM_SCOPE}:`, err);
        await handleCommandError(interaction, err);
    }
}

function sanitizeErrorMessage(err: unknown): string {
    if (!err) return "An unexpected error occurred.";
    const message = err instanceof Error ? err.message : String(err);
    if (!message) return "An unexpected error occurred.";

    // Guard against leaking internal file paths, syscall codes, stack traces, credentials, or internal IPs
    const containsSystemLeak =
        /([\\/][a-zA-Z0-9_.-]+){2,}|ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|at\s+[a-zA-Z0-9_.]+\s+\(|127\.0\.0\.1|0\.0\.0\.0|localhost|token|secret|password|api[_-]?key/i.test(message);

    if (containsSystemLeak) {
        return "An unexpected internal error occurred while executing this command.";
    }

    return message.length > 250 ? `${message.slice(0, 247)}...` : message;
}

async function handleCommandError(interaction: ChatInputCommandInteraction, err: unknown): Promise<void> {
    const msg = sanitizeErrorMessage(err);

    if (interaction.replied || interaction.deferred) {
        try {
            await interaction.followUp({
                embeds: [embed("error", `❌ ${msg}`)],
                flags: MessageFlags.Ephemeral,
            });
        } catch (replyError) {
            console.error("[Music][Interaction] Follow-up error response failed:", replyError);
        }
    } else if (interaction.isRepliable()) {
        try {
            await interaction.reply({
                embeds: [embed("error", `❌ ${msg}`)],
                flags: MessageFlags.Ephemeral,
            });
        } catch (replyError) {
            console.error("[Music][Interaction] Initial error response failed:", replyError);
        }
    }
}
