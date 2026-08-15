import type { GeckoClient } from "../client/GeckoClient.js";
import { GuildPlaybackController } from "./GuildPlaybackController.js";

/**
 * Clean, single entry point for starting audio playback on a guild.
 */
export async function play(client: GeckoClient, guildId: string): Promise<void> {
    const queue = client.queues.get(guildId);
    if (!queue || queue.isDestroyed) return;

    let controller = queue.getController<GuildPlaybackController>();
    if (!controller) {
        controller = new GuildPlaybackController(client, guildId, queue);
    }

    await controller.ensurePlayback();
}