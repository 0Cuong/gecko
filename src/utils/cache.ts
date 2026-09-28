interface CacheOptions {
    maxSize?: number;
    ttlMs?: number;
}

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export class LRUCache<K, V> {
    private cache = new Map<K, CacheEntry<V>>();
    private readonly maxSize: number;
    private readonly ttlMs: number;
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor(options: CacheOptions = {}) {
        this.maxSize = options.maxSize ?? 500;
        this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;

        this.startCleanupTimer();
    }

    public get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }

        this.cache.delete(key);
        this.cache.set(key, entry);

        return entry.value;
    }

    public set(key: K, value: V, customTtlMs?: number): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }

        const ttl = customTtlMs ?? this.ttlMs;
        this.cache.set(key, {
            value,
            expiresAt: Date.now() + ttl,
        });
    }

    public has(key: K): boolean {
        return this.get(key) !== undefined;
    }

    public delete(key: K): boolean {
        return this.cache.delete(key);
    }

    public clear(): void {
        this.cache.clear();
    }

    public size(): number {
        return this.cache.size;
    }

    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.cache.entries()) {
                if (now > entry.expiresAt) {
                    this.cache.delete(key);
                }
            }
        }, 5 * 60 * 1000);

        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    public destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.cache.clear();
    }
}
