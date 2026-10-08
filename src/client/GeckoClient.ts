/**
 * Gecko Music Bot
 * Original project by 0Cuong (https://github.com/0Cuong)
 */

import {
    Client,
    Collection,
    GatewayIntentBits,
    REST,
    Routes,
    type ClientOptions,
} from "discord.js";
import type { GeckoConfig } from "../config/index.js";
import type { GuildQueue } from "../queue/GuildQueue.js";
import type { SlashCommand } from "./types.js";

const defaultIntents: ClientOptions["intents"] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
];

export class GeckoClient extends Client {
    public readonly queues = new Map<string, GuildQueue>();
    public readonly commands = new Collection<string, SlashCommand>();
    public config: GeckoConfig = null!;

    public constructor() {
        super({ intents: defaultIntents });
        this.installDirectGatewayFallback();
    }

    /**
     * Some shared cloud egress IPs can be rate-limited on Discord's /gateway/bot
     * REST route even when the Gateway WebSocket itself is reachable. When the
     * explicit fallback is enabled, bypass only that discovery request and use
     * Discord's canonical Gateway URL with a single shard.
     */
    private installDirectGatewayFallback(): void {
        if (process.env.GECKO_DIRECT_GATEWAY_FALLBACK !== "true") return;

        const wsWrapper = this.ws as any;
        const descriptor = Object.getOwnPropertyDescriptor(wsWrapper, "_ws");
        if (!descriptor || !descriptor.configurable) return;

        let internalManager: any = null;
        const gatewayInformation = {
            url: "wss://gateway.discord.gg",
            shards: 1,
            session_start_limit: {
                total: 1000,
                remaining: 1000,
                reset_after: 0,
                max_concurrency: 1,
            },
        };

        Object.defineProperty(wsWrapper, "_ws", {
            configurable: true,
            enumerable: descriptor.enumerable,
            get: () => internalManager,
            set: (value: any) => {
                internalManager = value;
                if (value && typeof value.fetchGatewayInformation === "function") {
                    value.fetchGatewayInformation = async () => gatewayInformation;
                }
            },
        });
    }

    public async registerCommands(): Promise<void> {
        const rest = new REST().setToken(this.config.token);
        const payload = [...this.commands.values()].map((c) => c.data.toJSON());

        if (this.config.devGuildId) {
            await rest.put(
                Routes.applicationGuildCommands(this.user!.id, this.config.devGuildId),
                { body: payload },
            );
            console.info(`[Gecko] Registered ${payload.length} commands to guild ${this.config.devGuildId}`);
        } else {
            await rest.put(Routes.applicationCommands(this.user!.id), { body: payload });
            console.info(`[Gecko] Registered ${payload.length} global commands`);
        }
    }
}
