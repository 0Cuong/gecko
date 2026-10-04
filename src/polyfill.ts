/**
 * Global runtime polyfills for cross-version Node.js compatibility (Node 20, 22, 23).
 * Fixes: TypeError: webidl.util.markAsUncloneable is not a function in Node 20.x (undici CacheStorage)
 */
import workerThreads from "node:worker_threads";

if (typeof (workerThreads as any).markAsUncloneable !== "function") {
    (workerThreads as any).markAsUncloneable = (target: unknown) => target;
}
