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
