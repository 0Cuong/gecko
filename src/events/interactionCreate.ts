import { MessageFlags, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { embed } from "../utils/embeds.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { securityManager, sanitizeUserErrorMessage } from "../utils/security.js";
import { dbAdapter } from "../database/DatabaseAdapter.js";
import { PermissionsBitField, GuildMember } from "discord.js";

const DM_SCOPE = "DM";
const DJ_COMMANDS = new Set(["clear", "remove", "move", "stop", "leave", "volume", "loop", "shuffle", "autoplay", "previous"]);

export default async function interactionCreate(
    interaction: Interaction,
    client: GeckoClient,
): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName;
    const guildId = interaction.guildId ?? DM_SCOPE;

    console.info(
        `[Music][Interaction] Received /${commandName} guild=${guildId} user=${interaction.user.id}`,
    );

    // Commands own their acknowledgement path so each command can choose the
    // correct response semantics. /play uses the hardened direct REST transport.

    try {
        const command = client.commands.get(commandName);
        if (!command) {
        clearTimeout(autoAckTimer);
        console.warn(`[Music][Interaction] Unknown command /${commandName}; replying instead of silently dropping interaction.`);
        try {
            await interaction.reply({
                embeds: [embed("error", "This command is no longer loaded. Please reopen the slash-command menu and try again.")],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error(`[Music][Interaction] Unknown command response failed /${commandName}:`, error);
        }
        return;
    }

    if (interaction.guildId && DJ_COMMANDS.has(interaction.commandName)) {
        const settings = await dbAdapter.getGuildSettings(interaction.guildId);
        if (settings.djRoleId) {
            const member = interaction.member instanceof GuildMember
                ? interaction.member
                : await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
            const isAdmin = Boolean(member?.permissions.has(PermissionsBitField.Flags.Administrator));
            const hasDjRole = Boolean(member?.roles.cache.has(settings.djRoleId));
            if (!isAdmin && !hasDjRole) {
                await interaction.reply({
                    embeds: [embed("error", "You need the configured DJ role or Administrator permission to use this command.")],
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
                return;
            }
        }
    }

    const cooldown = securityManager.checkCooldown(
        interaction.user.id,
        interaction.commandName,
        undefined,
        guildId,
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
        if (interaction.replied || interaction.deferred) {
            console.info(
                `[Music][Interaction] Completed /${commandName} acknowledged=${interaction.replied ? "replied" : "deferred"} autoAcknowledged=${autoAcknowledged}`,
            );
        } else {
            console.warn(`[Music][Interaction] /${commandName} finished without an acknowledgement.`);
        }
    } catch (err) {
        console.error(`[Music][Interaction] Command failed command=${commandName} guild=${guildId}:`, err);
        await handleCommandError(interaction, err);
    } finally {
        clearTimeout(autoAckTimer);
    }
    } catch (err) {
        console.error(`[Music][Interaction] Pre-command handling failed command=${commandName} guild=${guildId}:`, err);
        await handleCommandError(interaction, err);
    }
}

async function handleCommandError(interaction: ChatInputCommandInteraction, err: unknown): Promise<void> {
    const msg = sanitizeUserErrorMessage(err);

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
