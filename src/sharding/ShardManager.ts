export interface ShardClusterInfo {
    shardId: number;
    totalShards: number;
    guildCount: number;
    pingMs: number;
}

export class ShardManager {
    private totalShards: number;
    private shards = new Map<number, ShardClusterInfo>();

    constructor(totalShards = 1) {
        this.totalShards = totalShards;
    }

    public getShardIdForGuild(guildId: string): number {
        // Discord Gateway Standard Sharding Hash Formula
        const BigIntGuildId = BigInt(guildId);
        return Number((BigIntGuildId >> 22n) % BigInt(this.totalShards));
    }

    public registerShard(shardId: number, guildCount: number, pingMs: number): void {
        this.shards.set(shardId, {
            shardId,
            totalShards: this.totalShards,
            guildCount,
            pingMs,
        });
    }

    public getClusterStats(): ShardClusterInfo[] {
        return [...this.shards.values()];
    }

    public getTotalGuilds(): number {
        return [...this.shards.values()].reduce((acc, s) => acc + s.guildCount, 0);
    }
}

export const shardManager = new ShardManager();
