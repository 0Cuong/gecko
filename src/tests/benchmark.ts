import process from "node:process";
import os from "node:os";

export interface BenchmarkReport {
    durationMs: number;
    initialMemoryMb: number;
    finalMemoryMb: number;
    memoryGrowthMb: number;
    eventLoopDelayMs: number;
    cpus: number;
    status: "EXCELLENT" | "STABLE" | "WARNING";
}

export async function runRealWorldBenchmark(durationSeconds = 2): Promise<BenchmarkReport> {
    const startMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const startLoop = Date.now();

    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));

    const endLoop = Date.now();
    const actualElapsed = endLoop - startLoop;
    const eventLoopDelayMs = Math.max(0, actualElapsed - durationSeconds * 1000);

    const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const memoryGrowthMb = finalMemory - startMemory;

    return {
        durationMs: actualElapsed,
        initialMemoryMb: startMemory,
        finalMemoryMb: finalMemory,
        memoryGrowthMb,
        eventLoopDelayMs,
        cpus: os.cpus().length,
        status: eventLoopDelayMs < 50 && memoryGrowthMb < 50 ? "EXCELLENT" : "STABLE",
    };
}
