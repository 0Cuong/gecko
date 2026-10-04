/**
 * Gecko Discord Bot Control Center - Event & Activity Logger
 * In-memory circular buffer with Server-Sent Events (SSE) broadcast.
 */

import type http from "node:http";

export type LogLevel = "info" | "warn" | "error" | "success";

export interface ControlLogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    type: string;
    message: string;
    details?: Record<string, unknown> | string;
}

const MAX_LOGS = 250;
const logs: ControlLogEntry[] = [];
const sseClients = new Set<http.ServerResponse>();

export function addControlLog(
    level: LogLevel,
    type: string,
    message: string,
    details?: Record<string, unknown> | string
): ControlLogEntry {
    const entry: ControlLogEntry = {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        level,
        type,
        message,
        details
    };

    logs.push(entry);
    if (logs.length > MAX_LOGS) {
        logs.shift();
    }

    // Broadcast to active SSE subscribers
    broadcastLogToSse(entry);

    return entry;
}

export function getControlLogs(limit = 100): ControlLogEntry[] {
    return logs.slice(-limit);
}

export function clearControlLogs(): void {
    logs.length = 0;
    addControlLog("info", "LOGS_CLEARED", "Nhật ký hệ thống đã được xóa bởi quản trị viên.");
}

function broadcastLogToSse(entry: ControlLogEntry): void {
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(data);
        } catch {
            sseClients.delete(client);
        }
    }
}

export function registerSseClient(res: http.ServerResponse): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no"
    });

    // Send initial keep-alive comment and recent history
    res.write(`: connected at ${new Date().toISOString()}\n\n`);
    const recent = getControlLogs(50);
    res.write(`data: ${JSON.stringify({ type: "INIT_HISTORY", logs: recent })}\n\n`);

    sseClients.add(res);

    // Keep-alive heartbeat every 15s to prevent intermediate proxy timeout
    const heartbeat = setInterval(() => {
        try {
            res.write(`: ping\n\n`);
        } catch {
            clearInterval(heartbeat);
            sseClients.delete(res);
        }
    }, 15000);

    res.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
}
