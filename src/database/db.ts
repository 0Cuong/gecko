import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

class DatabaseService {
    private dataDir = nodePath.resolve(process.cwd(), "cache", "data");
    private settingsFile = nodePath.resolve(this.dataDir, "settings.json");
    private profilesFile = nodePath.resolve(this.dataDir, "profiles.json");
    private snapshotsFile = nodePath.resolve(this.dataDir, "snapshots.json");

    private guildSettings = new Map<string, GuildSettings>();
    private userProfiles = new Map<string, UserProfile>();
    private queueSnapshots = new Map<string, QueueSnapshot>();

    constructor() {
        this.init();
    }

    private init(): void {
        try {
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true });
            }

            if (existsSync(this.settingsFile)) {
                const raw = readFileSync(this.settingsFile, "utf-8");
                const parsed: GuildSettings[] = JSON.parse(raw);
                parsed.forEach((s) => this.guildSettings.set(s.guildId, s));
            }

            if (existsSync(this.profilesFile)) {
                const raw = readFileSync(this.profilesFile, "utf-8");
                const parsed: UserProfile[] = JSON.parse(raw);
                parsed.forEach((p) => this.userProfiles.set(p.userId, p));
            }

            if (existsSync(this.snapshotsFile)) {
                const raw = readFileSync(this.snapshotsFile, "utf-8");
                const parsed: QueueSnapshot[] = JSON.parse(raw);
                parsed.forEach((q) => this.queueSnapshots.set(q.guildId, q));
            }
        } catch (err) {
            console.error("[DatabaseService] Error initializing database files:", err);
        }
    }

    public getGuildSettings(guildId: string): GuildSettings {
        return (
            this.guildSettings.get(guildId) ?? {
                guildId,
                volume: 80,
                autoplay: false,
                loopMode: "off",
            }
        );
    }

    public saveGuildSettings(settings: GuildSettings): void {
        this.guildSettings.set(settings.guildId, settings);
        this.persistSettings();
    }

    public getUserProfile(userId: string): UserProfile {
        return (
            this.userProfiles.get(userId) ?? {
                userId,
                favorites: [],
                history: [],
            }
        );
    }

    public saveUserProfile(profile: UserProfile): void {
        this.userProfiles.set(profile.userId, profile);
        this.persistProfiles();
    }

    public saveQueueSnapshot(snapshot: QueueSnapshot): void {
        this.queueSnapshots.set(snapshot.guildId, snapshot);
        this.persistSnapshots();
    }

    public getQueueSnapshot(guildId: string): QueueSnapshot | undefined {
        return this.queueSnapshots.get(guildId);
    }

    public deleteQueueSnapshot(guildId: string): void {
        this.queueSnapshots.delete(guildId);
        this.persistSnapshots();
    }

    private persistSettings(): void {
        try {
            const arr = [...this.guildSettings.values()];
            writeFileSync(this.settingsFile, JSON.stringify(arr, null, 2));
        } catch (e) {
            console.error("[DatabaseService] Error persisting settings:", e);
        }
    }

    private persistProfiles(): void {
        try {
            const arr = [...this.userProfiles.values()];
            writeFileSync(this.profilesFile, JSON.stringify(arr, null, 2));
        } catch (e) {
            console.error("[DatabaseService] Error persisting profiles:", e);
        }
    }

    private persistSnapshots(): void {
        try {
            const arr = [...this.queueSnapshots.values()];
            writeFileSync(this.snapshotsFile, JSON.stringify(arr, null, 2));
        } catch (e) {
            console.error("[DatabaseService] Error persisting queue snapshots:", e);
        }
    }
}

export const db = new DatabaseService();
