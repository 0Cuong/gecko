import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import type { Song } from "../queue/types.js";

export interface GuildSettings {
    guildId: string;
    volume: number;
    autoplay: boolean;
    loopMode: "off" | "track" | "queue";
    defaultChannelId?: string;
    djRoleId?: string;
}

export interface UserProfile {
    userId: string;
    favorites: Song[];
    history: Song[];
}

export interface QueueSnapshot {
    guildId: string;
    textChannelId: string;
    songs: Song[];
    currentIndex: number;
    timestamp: number;
}

type Row = { payload?: string };

class DatabaseService {
    private readonly dataDir = nodePath.resolve(process.cwd(), "cache", "data");
    private readonly dbFile = nodePath.resolve(this.dataDir, "gecko.sqlite");
    private readonly database: DatabaseSync;

    constructor() {
        if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
        this.database = new DatabaseSync(this.dbFile);
        this.initializeSchema();
        this.migrateLegacyJson();
    }

    private initializeSchema(): void {
        this.database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS guild_settings (
                guild_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS user_profiles (
                user_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS queue_snapshots (
                guild_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            ) STRICT;
        `);
    }

    private migrateLegacyJson(): void {
        const marker = this.database
            .prepare("SELECT value FROM schema_meta WHERE key = ?")
            .get("legacy_json_migrated") as { value?: string } | undefined;
        if (marker?.value === "1") return;

        const settingsFile = nodePath.resolve(this.dataDir, "settings.json");
        const profilesFile = nodePath.resolve(this.dataDir, "profiles.json");
        const snapshotsFile = nodePath.resolve(this.dataDir, "snapshots.json");

        this.database.exec("BEGIN IMMEDIATE");
        try {
            this.importArray<GuildSettings>(settingsFile, (item) => typeof item?.guildId === "string",
                "guild_settings", "guild_id", (item) => item.guildId);
            this.importArray<UserProfile>(profilesFile, (item) => typeof item?.userId === "string",
                "user_profiles", "user_id", (item) => item.userId);
            this.importArray<QueueSnapshot>(snapshotsFile, (item) => typeof item?.guildId === "string",
                "queue_snapshots", "guild_id", (item) => item.guildId);

            this.database
                .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)")
                .run("legacy_json_migrated", "1");
            this.database.exec("COMMIT");
        } catch (error) {
            try { this.database.exec("ROLLBACK"); } catch {}
            throw error;
        }
    }

    private importArray<T>(
        file: string,
        validate: (value: T) => boolean,
        table: string,
        idColumn: string,
        idOf: (value: T) => string
    ): void {
        if (!existsSync(file)) return;
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error(`Legacy database file is not an array: ${file}`);
        const stmt = this.database.prepare(
            `INSERT OR IGNORE INTO ${table}(${idColumn}, payload) VALUES(?, ?)`
        );
        for (const item of parsed as T[]) {
            if (!validate(item)) throw new Error(`Invalid legacy database record: ${file}`);
            stmt.run(idOf(item), JSON.stringify(item));
        }
    }

    public getGuildSettings(guildId: string): GuildSettings {
        const row = this.database.prepare("SELECT payload FROM guild_settings WHERE guild_id = ?").get(guildId) as Row | undefined;
        if (row?.payload) return JSON.parse(row.payload) as GuildSettings;
        return { guildId, volume: 80, autoplay: false, loopMode: "off" };
    }

    public saveGuildSettings(settings: GuildSettings): void {
        this.database
            .prepare("INSERT INTO guild_settings(guild_id, payload) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET payload=excluded.payload")
            .run(settings.guildId, JSON.stringify(settings));
    }

    public getUserProfile(userId: string): UserProfile {
        const row = this.database.prepare("SELECT payload FROM user_profiles WHERE user_id = ?").get(userId) as Row | undefined;
        if (row?.payload) return JSON.parse(row.payload) as UserProfile;
        return { userId, favorites: [], history: [] };
    }

    public saveUserProfile(profile: UserProfile): void {
        this.database
            .prepare("INSERT INTO user_profiles(user_id, payload) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload")
            .run(profile.userId, JSON.stringify(profile));
    }

    public saveQueueSnapshot(snapshot: QueueSnapshot): void {
        this.database
            .prepare("INSERT INTO queue_snapshots(guild_id, payload) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET payload=excluded.payload")
            .run(snapshot.guildId, JSON.stringify(snapshot));
    }

    public getQueueSnapshot(guildId: string): QueueSnapshot | undefined {
        const row = this.database.prepare("SELECT payload FROM queue_snapshots WHERE guild_id = ?").get(guildId) as Row | undefined;
        return row?.payload ? JSON.parse(row.payload) as QueueSnapshot : undefined;
    }

    public deleteQueueSnapshot(guildId: string): void {
        this.database.prepare("DELETE FROM queue_snapshots WHERE guild_id = ?").run(guildId);
    }
}

export const db = new DatabaseService();
