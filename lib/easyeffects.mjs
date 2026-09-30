// Replay a saved clip through EasyEffects' input chain (Linux, PipeWire, EasyEffects running with
// "use default input" on). A temporary pw-loopback makes a virtual mic (sink wlab_replay_in →
// source wlab_replay); it becomes the default input, which EasyEffects follows; the clip plays
// into it while pw-record captures easyeffects_source. The previous default input (and preset,
// if one was loaded) is always restored and the loopback removed.
//
// Never audible: pw-play starts unconnected, with no fallback, is linked by name to
// wlab_replay_in only after that sink is confirmed, and any link to a hardware output aborts.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseWav } from "./backends.mjs";

const RC = join(homedir(), ".config/easyeffects/db/easyeffectsrc");
const PRESETS = join(homedir(), ".local/share/easyeffects/input");
const SINK = "wlab_replay_in";
const SOURCE = "wlab_replay";
const PLAYER = "wlab_replay_play";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10000 }, (err, out) => (err ? reject(err) : resolve(out.trim()))));
const exited = (p, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => (p.kill("SIGKILL"), reject(new Error(`${p.spawnfile} timed out`))), ms);
    p.on("exit", () => (clearTimeout(t), resolve()));
  });
const hasNode = async (kind, name) => (await run("pactl", ["list", "short", kind])).split("\n").some((l) => l.split("\t")[1] === name);

/** {available, preset?, presets?, reason?}: the replay button shows only when available. */
export async function eeStatus() {
  if (process.platform !== "linux") return { available: false, reason: "Linux only" };
  try {
    if (!(await hasNode("sources", "easyeffects_source"))) return { available: false, reason: "EasyEffects isn't running" };
    if (existsSync(RC) && /^useDefaultInputDevice=false/m.test(readFileSync(RC, "utf8"))) {
      return { available: false, reason: "EasyEffects doesn't follow the default input (turn on 'use default input')" };
    }
    const presets = existsSync(PRESETS) ? readdirSync(PRESETS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
    return { available: true, preset: await run("easyeffects", ["-a", "input"]), presets };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/** Throws if any wlab_* port links to a hardware output. */
async function assertSilent() {
  let port = "";
  for (const line of (await run("pw-link", ["-l"])).split("\n")) {
    const m = /^\s+\|[-<>]+ (.+)$/.exec(line);
    if (!m) port = line.trim();
    else if ([port, m[1]].some((p) => p.startsWith("wlab_")) && [port, m[1]].some((p) => p.startsWith("alsa_output"))) {
      throw new Error(`replay aborted: ${port} is linked to ${m[1]}`);
    }
  }
}

/** Mono Int16 at 16 kHz → WAV bytes. */
function wavBytes(pcm, rate = 16000) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + pcm.length * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2).copy(b, 44);
  return b;
}

/** The part of `rec` that lines up with `src` (1 ms envelope cross-correlation), `src`'s length. */
function align(src, rec) {
  const H = 16;
  const env = (p) => Float32Array.from({ length: Math.floor(p.length / H) }, (_, i) => {
    let s = 0;
    for (let j = 0; j < H; j++) s += Math.abs(p[i * H + j]);
    return s;
  });
  const a = env(src);
  const b = env(rec);
  let best = -1;
  let lag = 0;
  for (let l = 0; l + a.length <= b.length; l++) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i + l];
    if (s > best) [best, lag] = [s, l];
  }
  const out = new Int16Array(src.length);
  out.set(rec.subarray(lag * H, lag * H + src.length));
  return { pcm: out, offsetMs: lag };
}

let busy = false;
let restore = null; // sync restore for SIGTERM mid-replay

/** Replays a 16 kHz mono WAV file through EasyEffects → {wav, preset, offsetMs}. */
export async function replay(wavPath, preset) {
  if (busy) throw Object.assign(new Error("a replay is already running"), { status: 409 });
  busy = true;
  const src = parseWav(readFileSync(wavPath));
  const tmp = mkdtempSync(join(tmpdir(), "whisper-lab-"));
  const out = join(tmp, "out.wav");
  const procs = [];
  const prevSource = await run("pactl", ["get-default-source"]).catch(() => null);
  const prevPreset = await run("easyeffects", ["-a", "input"]).catch(() => null);
  let loaded = false;
  restore = () => {
    for (const p of procs) p.kill();
    if (prevSource) spawn("pactl", ["set-default-source", prevSource]);
    if (loaded && prevPreset) spawn("easyeffects", ["-l", prevPreset]);
  };
  try {
    if (!prevSource || !prevPreset) throw new Error("couldn't read the current default input or EasyEffects preset");
    if (preset && preset !== prevPreset) {
      if (!existsSync(join(PRESETS, `${preset}.json`))) throw Object.assign(new Error(`no input preset ${preset}`), { status: 400 });
      await run("easyeffects", ["-l", preset]);
      loaded = true;
      await sleep(700);
      if ((await run("easyeffects", ["-a", "input"])) !== preset) throw new Error(`EasyEffects didn't load ${preset}`);
    }
    const props = (cls, name) => `media.class=${cls} node.name=${name} priority.session=0 priority.driver=0`;
    procs.push(spawn("pw-loopback", ["-n", SOURCE, "-c", "1", "-m", "[ MONO ]", `--capture-props=${props("Audio/Sink", SINK)}`, `--playback-props=${props("Audio/Source", SOURCE)}`], { stdio: "ignore" }));
    for (let i = 0; !((await hasNode("sinks", SINK)) && (await hasNode("sources", SOURCE))); i++) {
      if (i > 30) throw new Error("the virtual mic didn't appear");
      await sleep(100);
    }
    await run("pactl", ["set-default-source", SOURCE]);
    await sleep(600); // EasyEffects relinks its input
    const rec = spawn("pw-record", ["--target", "easyeffects_source", "--rate", "16000", "--channels", "1", "--format", "s16", out], { stdio: "ignore" });
    procs.push(rec);
    await sleep(300);
    const player = spawn("pw-play", ["-P", `{ node.name=${PLAYER} node.autoconnect=false node.dont-fallback=true node.dont-reconnect=true }`, wavPath], { stdio: "ignore" });
    procs.push(player);
    for (let i = 0; ; i++) {
      try {
        await run("pw-link", [`${PLAYER}:output_MONO`, `${SINK}:playback_MONO`]);
        break;
      } catch (err) {
        if (i > 30) throw new Error(`couldn't link the player to ${SINK}: ${err.message}`);
        await sleep(100);
      }
    }
    await assertSilent();
    await exited(player, (src.audioSec + 10) * 1000);
    await sleep(600); // tail: plugin latency and look-ahead
    rec.kill("SIGINT");
    await exited(rec, 3000);
    const { pcm, offsetMs } = align(src.pcm, parseWav(readFileSync(out)).pcm);
    return { wav: wavBytes(pcm), preset: preset || prevPreset, offsetMs };
  } finally {
    for (const p of procs) p.kill();
    await run("pactl", ["set-default-source", prevSource]).catch((err) => console.error(`restoring the default input failed: ${err.message}`));
    if (loaded) await run("easyeffects", ["-l", prevPreset]).catch((err) => console.error(`restoring preset ${prevPreset} failed: ${err.message}`));
    rmSync(tmp, { recursive: true, force: true });
    restore = null;
    busy = false;
  }
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    restore?.();
    process.exit(0);
  });
}
