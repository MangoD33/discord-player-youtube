import { spawn } from "node:child_process";

let _checked = false;
let _available = false;

function ytDlpBin(): string {
    return process.env.YTDLP_PATH || "yt-dlp";
}

export async function ytDlpAvailable(): Promise<boolean> {
    if (_checked) return _available;
    _checked = true;
    try {
        await new Promise<void>((resolve, reject) => {
            const p = spawn(ytDlpBin(), ["--version"], { stdio: "ignore" });
            p.once("error", reject);
            p.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(String(code)))));
        });
        _available = true;
    } catch {
        _available = false;
    }
    return _available;
}

function runYtDlpJson(url: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
        const p = spawn(ytDlpBin(), [url, ...args], { windowsHide: true });
        let output = "";
        p.stdout?.on("data", (c) => (output += String(c)));
        p.stderr?.on("data", (c) => (output += String(c)));
        p.on("error", reject);
        p.on("close", (code) => {
            if (code === 0) {
                try { resolve(JSON.parse(output)); } catch (e) { reject(e); }
            } else {
                reject(new Error(output || `yt-dlp exited with ${code}`));
            }
        });
    });
}

export async function ytDlpBestAudioUrl(url: string): Promise<string> {
    if (!(await ytDlpAvailable())) throw new Error("YTDLP_UNAVAILABLE");
    const flags = [
        "--dump-single-json",
        "--no-warnings",
        "--no-call-home",
        "--prefer-free-formats",
        "--skip-download",
        "--simulate",
        "-f", "ba/ba*",
    ];
    const info: any = await runYtDlpJson(url, flags);
    if (!info || typeof info !== "object") throw new Error("YTDLP_INVALID_JSON");
    if (Array.isArray((info as any).entries)) throw new Error("YTDLP_PLAYLIST_NOT_SUPPORTED");
    if ((info as any).url) return String((info as any).url);
    // Fallback: find best audio-only format
    const formats: any[] = Array.isArray((info as any).formats) ? (info as any).formats : [];
    const audioOnly = formats.filter(f => (f.acodec && f.acodec !== "none") && (!f.vcodec || f.vcodec === "none"));
    const best = audioOnly.sort((a, b) => (Number(b.abr) || 0) - (Number(a.abr) || 0))[0];
    if (best?.url) return String(best.url);
    throw new Error("YTDLP_NO_AUDIO_URL");
}

export async function ytDlpDumpSingleJson(url: string, extraFlags: string[] = []): Promise<any> {
    if (!(await ytDlpAvailable())) throw new Error("YTDLP_UNAVAILABLE");
    const flags = [
        "--dump-single-json",
        "--no-warnings",
        "--no-call-home",
        "--prefer-free-formats",
        "--skip-download",
        "--simulate",
        ...extraFlags,
    ];
    return runYtDlpJson(url, flags);
}

export async function streamUrl(url: string): Promise<string> {
    return ytDlpBestAudioUrl(url);
}

export default {
    ytDlpAvailable,
    ytDlpBestAudioUrl,
    ytDlpDumpSingleJson,
    streamUrl,
};
