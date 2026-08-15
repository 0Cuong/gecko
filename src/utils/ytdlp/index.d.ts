import type { ChildProcess } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

export interface YtdlpOptions {
    [key: string]: string | boolean;
}

export function isBotDetectionError(errorMessage: string | undefined): boolean;
export function isAgeRestrictedError(errorMessage: string | undefined): boolean;
export function isUnavailableMediaError(errorMessage: string | undefined): boolean;
export function downloadExecutable(): Promise<void>;
export function startAutoUpdater(): void;
export function stopAutoUpdater(): void;
export function stopAutoUpdater(): void;
export function exec(
    url: string,
    options?: YtdlpOptions,
    spawnOptions?: SpawnOptions,
): ChildProcess;
export default function ytdl(
    url: string,
    options?: YtdlpOptions,
    spawnOptions?: SpawnOptions,
): Promise<unknown>;
