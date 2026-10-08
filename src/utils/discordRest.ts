import type { ChatInputCommandInteraction } from "discord.js";

const DISCORD_API_HOSTS = [
    "https://discord.com/api/v10",
    "https://canary.discord.com/api/v10",
    "https://ptb.discord.com/api/v10",
] as const;
const INTERACTION_TIMEOUT_MS = 4_000;

function callbackUrl(base: string, interaction: ChatInputCommandInteraction): string {
    return base + "/interactions/" + interaction.id + "/" + interaction.token + "/callback";
}

function webhookUrl(base: string, interaction: ChatInputCommandInteraction, suffix = ""): string {
    return base + "/webhooks/" + interaction.applicationId + "/" + interaction.token + suffix;
}

function serializeDiscordValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(serializeDiscordValue);

    if (value && typeof value === "object") {
        const encodable = value as { toJSON?: () => unknown };
        if (typeof encodable.toJSON === "function") return serializeDiscordValue(encodable.toJSON());

        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (key === "files" || key === "file") continue;
            output[key] = serializeDiscordValue(entry);
        }
        return output;
    }

    return value;
}

async function fetchWithFailover(
    urlFactory: (base: string) => string,
    init: RequestInit,
    operation: string,
): Promise<Response> {
    let lastError: unknown;

    for (const base of DISCORD_API_HOSTS) {
        const startedAt = Date.now();
        try {
            const response = await fetch(urlFactory(base), {
                ...init,
                signal: AbortSignal.timeout(INTERACTION_TIMEOUT_MS),
                headers: {
                    "content-type": "application/json",
                    "user-agent": "DiscordBot (https://discord.js.org, 14.27.0) Gecko/1.0",
                    ...(init.headers ?? {}),
                },
            });

            const elapsed = Date.now() - startedAt;
            const retryAfter = response.headers.get("retry-after");
            const cfRay = response.headers.get("cf-ray");
            const server = response.headers.get("server");
            console.info(
                "[Music][DiscordREST] " + operation + " via " + base + " HTTP " + response.status + " in " + elapsed + "ms." +
                (retryAfter ? " retry-after=" + retryAfter : "") +
                (cfRay ? " cf-ray=" + cfRay : "") +
                (server ? " server=" + server : ""),
            );

            if (response.ok) return response;

            const body = await response.text().catch(() => "");
            lastError = new Error(
                operation + " failed with HTTP " + response.status + " at " + base +
                (body ? ": " + body.slice(0, 220).replace(/\\s+/g, " ") : ""),
            );

            // A 429 from one Discord edge should not prevent trying the next official edge.
            if (![429, 500, 502, 503, 504].includes(response.status)) break;
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[Music][DiscordREST] " + operation + " transport via " + base + " failed: " + message);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? operation + " failed"));
}

export async function deferInteractionDirect(
    interaction: ChatInputCommandInteraction,
    flags = 0,
): Promise<void> {
    if (interaction.deferred || interaction.replied) return;

    console.info("[Music][DiscordREST] ACK /" + interaction.commandName + " via Discord interaction transport...");

    await fetchWithFailover(
        (base) => callbackUrl(base, interaction),
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

export async function editOriginalResponseDirect(
    interaction: ChatInputCommandInteraction,
    payload: Record<string, unknown>,
): Promise<void> {
    const body = serializeDiscordValue(payload) as Record<string, unknown>;

    await fetchWithFailover(
        (base) => webhookUrl(base, interaction, "/messages/@original"),
        { method: "PATCH", body: JSON.stringify(body) },
        "EDIT /" + interaction.commandName,
    );

    const state = interaction as ChatInputCommandInteraction & { replied: boolean };
    state.replied = true;
}

export async function followUpDirect(
    interaction: ChatInputCommandInteraction,
    payload: Record<string, unknown>,
): Promise<void> {
    const body = serializeDiscordValue(payload) as Record<string, unknown>;

    await fetchWithFailover(
        (base) => webhookUrl(base, interaction),
        { method: "POST", body: JSON.stringify(body) },
        "FOLLOWUP /" + interaction.commandName,
    );

    const state = interaction as ChatInputCommandInteraction & { replied: boolean };
    state.replied = true;
}
