/**
 * Format seconds into HH:MM:SS or MM:SS
 */
export function formatDuration(seconds: number): string {
    if (seconds <= 0) return "LIVE";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Truncate a string to maxLen, appending "…" if cut.
 */
export function truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

/**
 * Build a simple progress bar string.
 */
export function progressBar(current: number, total: number, size = 20): string {
    if (total <= 0) return "▬".repeat(size);
    const filled = Math.round((current / total) * size);
    return "▬".repeat(filled) + "🔘" + "▬".repeat(Math.max(0, size - filled - 1));
}
