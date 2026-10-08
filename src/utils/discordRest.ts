import type { ChatInputCommandInteraction } from "discord.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const INTERACTION_TIMEOUT_MS = 4_000;

function interactionUrl(interaction: ChatInputCommandInteraction): string {
    return DISCORD_API_BASE + "/interactions/" + interaction.id + "/" + interaction.token + "/callback";
}

function originalResponseUrl(interaction: ChatInputCommandInteraction): string {
    return DISCORD_API_BASE + "/webhooks/" + interaction.applicationId + "/" + interaction.token + "/messages/@original";
}

function serializeDiscordValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(serializeDiscordValue);

    if (value && typeof value === "object") {
        const encodable = value as { toJSON?: () => unknown };
        if (typeof encodable.toJSON === "function") {
            return serializeDiscordValue(encodable.toJSON());
        }

        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (key === "files" || key === "file") continue;
            output[key] = serializeDiscordValue(entry);
        }
        return output;
    }

    return value;
}

async function discordFetch(url: string, init: RequestInit, operation: string): Promise<Response> {
    const startedAt = Date.now();

    try {
        const response = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(INTERACTION_TIMEOUT_MS),
            headers: {
                "content-type": "application/json",
                "user-agent": "Gecko/1.0 interaction-transport",
                ...(init.headers ?? {}),
            },
        });

        console.info("[Music][DiscordREST] " + operation + " HTTP " + response.status + " in " + (Date.now() - startedAt) + "ms.");

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(operation + " failed with HTTP " + response.status + (body ? ": " + body.slice(0, 300) : ""));
        }

        return response;
    } catch (error) {
        const elapsed = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Music][DiscordREST] " + operation + " failed after " + elapsed + "ms: " + message);
        throw error;
    }
}

export async function deferInteractionDirect(interaction: ChatInputCommandInteraction, flags = 0): Promise<void> {
    if (interaction.deferred || interaction.replied) return;

    console.info("[Music][DiscordREST] ACK /" + interaction.commandName + " via direct HTTPS...");

    await discordFetch(
        interactionUrl(interaction),
        {
            method: "POST",
            body: JSON.stringify({
                type: 5,
                data: flags ? { flags } : undefined,
            }),
        },
        "ACK /" + interaction.commandName,
    );

    const state = interaction as ChatInputCommandInteraction & {
        deferred: boolean;
        replied: boolean;
        ephemeral: boolean;
    };
    state.deferred = true;
    state.replied = false;
    state.ephemeral = Boolean(flags & 64);
}

export async function editOriginalResponseDirect(interaction: ChatInputCommandInteraction, payload: Record<string, unknown>): Promise<void> {
    const body = serializeDiscordValue(payload) as Record<string, unknown>;

    await discordFetch(
        originalResponseUrl(interaction),
        {
            method: "PATCH",
            body: JSON.stringify(body),
        },
        "EDIT /" + interaction.commandName,
    );

    const state = interaction as ChatInputCommandInteraction & {
        deferred: boolean;
        replied: boolean;
    };
    state.replied = true;
}
