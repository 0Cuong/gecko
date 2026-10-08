import { MessageFlags, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { embed } from "../utils/embeds.js";
import type { GeckoClient } from "../client/GeckoClient.js";
import { securityManager, sanitizeUserErrorMessage } from "../utils/security.js";
import { dbAdapter } from "../database/DatabaseAdapter.js";
import { PermissionsBitField, GuildMember } from "discord.js";
import { deferInteractionDirect, editOriginalResponseDirect, followUpDirect } from "../utils/discordRest.js";

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

    // Every slash command must be acknowledged before database, permission,
    // member lookup, resolver, or voice work. This is the only safe way to
    // handle the Render -> Discord REST 429 condition without dropping users.
    try {
        await deferInteractionDirect(interaction);
        console.info(`[Music][Interaction] ACK /${commandName} succeeded.`);
    } catch (error) {
        console.error(`[Music][Interaction] ACK /${commandName} failed; command skipped.`, error);
        return;
    }

    const responseAware = interaction as ChatInputCommandInteraction & {
        reply: (options?: any) => Promise<any>;
        editReply: (options?: any) => Promise<any>;
        followUp: (options?: any) => Promise<any>;
        deferReply: (options?: any) => Promise<any>;
    };

    // Commands were written against discord.js InteractionResponses. Bridge those
    // methods to the same resilient transport after the initial defer.
    responseAware.reply = async (options = {}) =>
        editOriginalResponseDirect(interaction, (options ?? {}) as Record<string, unknown>);
    responseAware.editReply = async (options = {}) =>
        editOriginalResponseDirect(interaction, (options ?? {}) as Record<string, unknown>);
    responseAware.followUp = async (options = {}) =>
        followUpDirect(interaction, (options ?? {}) as Record<string, unknown>);
    responseAware.deferReply = async () => undefined;

    try {
        const command = client.commands.get(commandName);

        if (!command) {
            console.warn(
                `[Music][Interaction] Unknown command /${commandName}; replying instead of silently dropping interaction.`,
            );
            try {
                await interaction.reply({
                    embeds: [
                        embed(
                            "error",
                            "This command is no longer loaded. Please reopen the slash-command menu and try again.",
                        ),
                    ],
                    flags: MessageFlags.Ephemeral,
                });
            } catch (error) {
                console.error(
                    `[Music][Interaction] Unknown command response failed /${commandName}:`,
                    error,
                );
            }
            return;
        }

        if (interaction.guildId && DJ_COMMANDS.has(commandName)) {
            const settings = await dbAdapter.getGuildSettings(interaction.guildId);

            if (settings.djRoleId) {
                const member =
                    interaction.member instanceof GuildMember
                        ? interaction.member
                        : await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

                const isAdmin = Boolean(
                    member?.permissions.has(PermissionsBitField.Flags.Administrator),
                );
                const hasDjRole = Boolean(member?.roles.cache.has(settings.djRoleId));

                if (!isAdmin && !hasDjRole) {
                    await interaction
                        .reply({
                            embeds: [
                                embed(
                                    "error",
                                    "You need the configured DJ role or Administrator permission to use this command.",
                                ),
                            ],
                            flags: MessageFlags.Ephemeral,
                        })
                        .catch(() => {});
                    return;
                }
            }
        }

        const cooldown = securityManager.checkCooldown(
            interaction.user.id,
            commandName,
            undefined,
            guildId,
        );

        if (cooldown.onCooldown) {
            if (interaction.isRepliable()) {
                const remainingSec = Math.ceil(cooldown.remainingMs / 1_000);

                try {
                    await interaction.reply({
                        embeds: [
                            embed(
                                "warn",
                                `⏳ Please wait ${remainingSec} second(s) before retrying this command.`,
                            ),
                        ],
                        flags: MessageFlags.Ephemeral,
                    });
                } catch (error) {
                    console.error(
                        `[Music][Interaction] Cooldown reply failed command=${commandName} guild=${guildId}:`,
                        error,
                    );
                }
            }
            return;
        }

        try {
            console.info(`[Music][Interaction] Dispatching /${commandName}.`);
            await command.execute(interaction, client);

            if (interaction.replied || interaction.deferred) {
                console.info(
                    `[Music][Interaction] Completed /${commandName} acknowledged=${interaction.replied ? "replied" : "deferred"}.`,
                );
            } else {
                console.warn(
                    `[Music][Interaction] /${commandName} finished without an acknowledgement.`,
                );
            }
        } catch (error) {
            console.error(
                `[Music][Interaction] Command failed command=${commandName} guild=${guildId}:`,
                error,
            );
            await handleCommandError(interaction, error);
        }
    } catch (error) {
        console.error(
            `[Music][Interaction] Pre-command handling failed command=${commandName} guild=${guildId}:`,
            error,
        );
        await handleCommandError(interaction, error);
    }
}

async function handleCommandError(
    interaction: ChatInputCommandInteraction,
    err: unknown,
): Promise<void> {
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
