/**
 * Gecko Discord Bot Control Center - Authentication & Security Guard
 * Ensures privileged administrative actions are authenticated.
 */

import type http from "node:http";
import crypto from "node:crypto";
import { addControlLog } from "./logger.js";

const envKey = process.env.CONTROL_CENTER_KEY?.trim() || "";
// Local ephemeral dev token if none set in environment
const devSessionToken = envKey || crypto.randomBytes(16).toString("hex");

if (!envKey) {
    console.info(`[ControlCenter:Auth] CONTROL_CENTER_KEY not specified in env. Using development session token: ${devSessionToken}`);
}

export function verifyAdminAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers["authorization"] || "";
    const customKey = req.headers["x-control-key"];

    let providedKey = "";
    if (typeof customKey === "string") {
        providedKey = customKey.trim();
    } else if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
        providedKey = authHeader.slice(7).trim();
    }

    if (!providedKey) {
        // If no key was provided: if CONTROL_CENTER_KEY is not set in production env,
        // we can allow local loopback requests in dev mode
        const host = req.headers.host || "";
        const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
        if (!envKey && isLocal) {
            return true;
        }
        return false;
    }

    const expected = envKey || devSessionToken;
    try {
        const bufProvided = Buffer.from(providedKey);
        const bufExpected = Buffer.from(expected);
        if (bufProvided.length !== bufExpected.length) return false;
        return crypto.timingSafeEqual(bufProvided, bufExpected);
    } catch {
        return false;
    }
}

export function logAuthFailure(req: http.IncomingMessage, action: string): void {
    addControlLog("warn", "AUTH_DENIED", `Yêu cầu bị từ chối xác thực cho hành động: ${action}`, {
        ip: req.socket.remoteAddress,
        url: req.url,
        method: req.method
    });
}
