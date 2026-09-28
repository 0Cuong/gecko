import { GuildQueue } from "../queue/GuildQueue.js";
import type { Song } from "../queue/types.js";

export async function runStressTestSim(guildCount = 100): Promise<{ simulatedGuilds: number; success: boolean }> {
    console.info(`[StressTest] Simulating ${guildCount} active guild queues...`);
    const queues: GuildQueue[] = [];

    const mockSong: Song = {
        id: "dQw4w9WgXcQ",
        title: "Stress Test Track",
        sourceId: "dQw4w9WgXcQ",
        canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        webpageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        duration: 212,
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        requester: "Tester#0001",
        requesterId: "1234567890",
        isLive: false,
        author: "Rick Astley",
        source: "youtube",
    };

    for (let i = 0; i < guildCount; i++) {
        const queue = new GuildQueue(`channel_${i}`, 80);
        queue.add(mockSong);
        queues.push(queue);
    }

    // Cleanup simulation
    queues.forEach((q) => q.destroy());
    console.info(`[StressTest] Completed simulation for ${guildCount} guilds successfully.`);

    return { simulatedGuilds: guildCount, success: true };
}
