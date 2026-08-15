import process from "node:process";
import os from "node:os";

export interface SystemHealthStats {
    cpuUsagePercent: number;
    memoryUsedMb: number;
    memoryTotalMb: number;
    uptimeSeconds: number;
    activeQueuesCount: number;
    nodeVersion: string;
    platform: string;
}

export class PerformanceMonitor {
    private startTime = Date.now();

    public getHealthStats(activeQueuesCount: number): SystemHealthStats {
        const memory = process.memoryUsage();
        const memoryUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
        const memoryTotalMb = Math.round(os.totalmem() / 1024 / 1024);

        const cpus = os.cpus();
        let userTime = 0;
        let totalTime = 0;
        cpus.forEach((cpu) => {
            userTime += cpu.times.user + cpu.times.sys;
            totalTime += cpu.times.user + cpu.times.sys + cpu.times.idle + cpu.times.irq;
        });

        const cpuUsagePercent = Math.min(100, Math.round((userTime / (totalTime || 1)) * 100));

        return {
            cpuUsagePercent,
            memoryUsedMb,
            memoryTotalMb,
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            activeQueuesCount,
            nodeVersion: process.version,
            platform: process.platform,
        };
    }
}

export const monitor = new PerformanceMonitor();
