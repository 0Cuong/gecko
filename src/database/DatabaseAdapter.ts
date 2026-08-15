import { db, type GuildSettings, type UserProfile, type QueueSnapshot } from "./db.js";

export type DatabaseProviderType = "sqlite" | "postgres" | "json";

export interface IDatabaseAdapter {
    provider: DatabaseProviderType;
    getGuildSettings(guildId: string): Promise<GuildSettings>;
    saveGuildSettings(settings: GuildSettings): Promise<void>;
    getUserProfile(userId: string): Promise<UserProfile>;
    saveUserProfile(profile: UserProfile): Promise<void>;
    saveQueueSnapshot(snapshot: QueueSnapshot): Promise<void>;
    getQueueSnapshot(guildId: string): Promise<QueueSnapshot | undefined>;
    deleteQueueSnapshot(guildId: string): Promise<void>;
}

export class DefaultDatabaseAdapter implements IDatabaseAdapter {
    public readonly provider: DatabaseProviderType = "sqlite";

    public async getGuildSettings(guildId: string): Promise<GuildSettings> {
        return db.getGuildSettings(guildId);
    }

    public async saveGuildSettings(settings: GuildSettings): Promise<void> {
        db.saveGuildSettings(settings);
    }

    public async getUserProfile(userId: string): Promise<UserProfile> {
        return db.getUserProfile(userId);
    }

    public async saveUserProfile(profile: UserProfile): Promise<void> {
        db.saveUserProfile(profile);
    }

    public async saveQueueSnapshot(snapshot: QueueSnapshot): Promise<void> {
        db.saveQueueSnapshot(snapshot);
    }

    public async getQueueSnapshot(guildId: string): Promise<QueueSnapshot | undefined> {
        return db.getQueueSnapshot(guildId);
    }

    public async deleteQueueSnapshot(guildId: string): Promise<void> {
        db.deleteQueueSnapshot(guildId);
    }
}

export const dbAdapter: IDatabaseAdapter = new DefaultDatabaseAdapter();
