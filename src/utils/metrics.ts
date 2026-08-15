export interface MetricsData {
    playSuccessCount: number;
    playFailCount: number;
    totalResolveTimeMs: number;
    resolveCount: number;
    voiceReconnectCount: number;
    activePlayerCount: number;
    streamInterruptCount: number;
}

export class MetricsCollector {
    private metrics: MetricsData = {
        playSuccessCount: 0,
        playFailCount: 0,
        totalResolveTimeMs: 0,
        resolveCount: 0,
        voiceReconnectCount: 0,
        activePlayerCount: 0,
        streamInterruptCount: 0,
    };

    public recordPlaySuccess(): void {
        this.metrics.playSuccessCount++;
    }

    public recordPlayFail(): void {
        this.metrics.playFailCount++;
    }

    public recordResolveTime(timeMs: number): void {
        this.metrics.totalResolveTimeMs += timeMs;
        this.metrics.resolveCount++;
    }

    public recordVoiceReconnect(): void {
        this.metrics.voiceReconnectCount++;
    }

    public registerPlayer(): void {
        this.metrics.activePlayerCount++;
    }

    public unregisterPlayer(): void {
        this.metrics.activePlayerCount = Math.max(0, this.metrics.activePlayerCount - 1);
    }

    public recordStreamInterruption(): void {
        this.metrics.streamInterruptCount++;
    }

    public getAverageResolveTime(): number {
        if (this.metrics.resolveCount === 0) return 0;
        return Math.round(this.metrics.totalResolveTimeMs / this.metrics.resolveCount);
    }

    public toPrometheusFormat(): string {
        const avgResolve = this.getAverageResolveTime();
        return [
            `# HELP gecko_play_success_total Total successful playback starts`,
            `# TYPE gecko_play_success_total counter`,
            `gecko_play_success_total ${this.metrics.playSuccessCount}`,
            `# HELP gecko_play_fail_total Total failed playback attempts`,
            `# TYPE gecko_play_fail_total counter`,
            `gecko_play_fail_total ${this.metrics.playFailCount}`,
            `# HELP gecko_resolve_avg_ms Average query resolution time in milliseconds`,
            `# TYPE gecko_resolve_avg_ms gauge`,
            `gecko_resolve_avg_ms ${avgResolve}`,
            `# HELP gecko_voice_reconnect_total Total voice reconnection events`,
            `# TYPE gecko_voice_reconnect_total counter`,
            `gecko_voice_reconnect_total ${this.metrics.voiceReconnectCount}`,
            `# HELP gecko_active_players Current active guild player sessions`,
            `# TYPE gecko_active_players gauge`,
            `gecko_active_players ${this.metrics.activePlayerCount}`,
            `# HELP gecko_stream_interruptions_total Stream interruptions requiring recovery`,
            `# TYPE gecko_stream_interruptions_total counter`,
            `gecko_stream_interruptions_total ${this.metrics.streamInterruptCount}`,
        ].join("\n");
    }
}

export const metrics = new MetricsCollector();
