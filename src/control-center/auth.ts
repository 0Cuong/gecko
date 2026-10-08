/**
 * Gecko Discord Bot Control Center - Authentication & Security Guard
 * Privileged API access is fail-closed in production.
 */
import type http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import { addControlLog } from "./logger.js";

const isProduction = process.env.NODE_ENV === "production";
const envKey = process.env.CONTROL_CENTER_KEY?.trim() || "";

if (isProduction && !envKey) {
    throw new Error("CONTROL_CENTER_KEY is required in production.");
}

const DEV_RATE_LIMIT_WINDOW_MS = 60_000;
const DEV_RATE_LIMIT_MAX = 60;
const rateLimitState = new Map<string, { count: number; resetAt: number }>();

function normalizePeerAddress(address: string | undefined): string {
    const value = (address || "").trim().toLowerCase();
    if (value.startsWith("::ffff:")) return value.slice(7);
    return value;
}

export function isLoopbackPeer(req: http.IncomingMessage): boolean {
    const address = normalizePeerAddress(req.socket.remoteAddress);
    return net.isIP(address) === 4
        ? address === "127.0.0.1"
        : address === "::1";
}

export function consumeControlRateLimit(req: http.IncomingMessage): boolean {
    const now = Date.now();
    const key = normalizePeerAddress(req.socket.remoteAddress) || "unknown";
    const current = rateLimitState.get(key);
    if (!current || now >= current.resetAt) {
        rateLimitState.set(key, { count: 1, resetAt: now + DEV_RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (current.count >= DEV_RATE_LIMIT_MAX) return false;
    current.count += 1;
    return true;
}

const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of rateLimitState) {
        if (now >= state.resetAt) rateLimitState.delete(key);
    }
}, DEV_RATE_LIMIT_WINDOW_MS);
cleanupTimer.unref?.();

export function verifyAdminAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers["authorization"];
    const customKey = req.headers["x-control-key"];

    let providedKey = "";
    if (typeof customKey === "string") {
        providedKey = customKey.trim();
    } else if (typeof authHeader === "string" && /^bearer\s+/i.test(authHeader)) {
        providedKey = authHeader.replace(/^bearer\s+/i, "").trim();
    }

    // Production is key-only. Never trust Host, forwarding headers, origin, or URL.
    if (isProduction) {
        if (!providedKey || !envKey) return false;
    } else if (!envKey && !providedKey) {
        // Development compatibility: unauthenticated control access is allowed only
        // for a real loopback socket peer, never based on Host.
        return isLoopbackPeer(req);
    }

    if (!providedKey || !envKey) return false;

    const provided = Buffer.from(providedKey, "utf8");
    const expected = Buffer.from(envKey, "utf8");
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

export function logAuthFailure(req: http.IncomingMessage, action: string): void {
    addControlLog("warn", "AUTH_DENIED", "Control Center authentication failed.", {
        ip: normalizePeerAddress(req.socket.remoteAddress),
        action,
        method: req.method
    });
}
