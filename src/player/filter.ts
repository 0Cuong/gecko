import type { AudioFilterPreset } from "../queue/types.js";

export interface AudioFilterOptions {
    preset: AudioFilterPreset;
    speed: number;
    volume: number;
}

export function buildFfmpegFilterArgs(options: Partial<AudioFilterOptions> = {}): string[] {
    const preset = options.preset ?? "none";
    const speed = Math.max(0.25, Math.min(2.5, options.speed ?? 1));
    const volume = Math.max(0.1, Math.min(3, options.volume ?? 1));

    const args: string[] = [];

    if (preset === "bassboost") {
        args.push("-af", "asetrate=44100*1.0,aresample=async=1,volume=1.15,highpass=f=80,lowpass=f=14000");
    } else if (preset === "nightcore") {
        args.push("-af", `atempo=${speed},atempo=${Math.min(2.0, speed * 1.1)},volume=${volume}`);
    } else if (preset === "fast") {
        args.push("-af", `atempo=${Math.max(1.1, speed)},volume=${volume}`);
    } else if (preset === "slow") {
        args.push("-af", `atempo=${Math.max(0.5, Math.min(1.0, speed))},volume=${volume}`);
    } else {
        args.push("-af", `volume=${volume}`);
    }

    return args;
}
