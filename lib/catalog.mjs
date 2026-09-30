// The model catalog (models.json), the lab's config (config.json) and where everything lives on
// disk. The server imports this; install.sh and lab.sh run it as a small CLI (see the bottom), so
// ports, file names and pins are written down in one place only.
//
// State dir: $WHISPER_LAB_HOME, else $XDG_CACHE_HOME/whisper-lab, else ~/.cache/whisper-lab.

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const readJson = (name) => JSON.parse(readFileSync(join(REPO, name), "utf8"));

export const PINS = readJson("models.json");
export const MODELS = PINS.models;
export const CONFIG = readJson("config.json");
export const SENTENCES = readJson("sentences.json");
/** Sentence sets: `default` (sentences.json + config.json's jargon and prompt), then config.json's `sets`. */
export const SETS = { default: { sentences: SENTENCES, jargon: CONFIG.jargon ?? [], prompt: CONFIG.prompt ?? "" }, ...CONFIG.sets };

export function stateDir() {
  if (process.env.WHISPER_LAB_HOME) return process.env.WHISPER_LAB_HOME;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "whisper-lab");
}

export function paths(state = stateDir()) {
  return {
    state,
    models: join(state, "models"),
    downloads: join(state, "downloads"),
    run: join(state, "run"),
    clips: join(state, "clips"),
    whisperServer: join(state, "bin", "whisper-server"),
    backendFile: join(state, "bin", "backend"),
    transcribeDir: join(state, `transcribe-${PINS.transcribe.tag}`),
    transcribeHost: join(state, `transcribe-${PINS.transcribe.tag}`, "transcribe-host"),
    vad: join(state, "models", PINS.vad.file),
  };
}

const envPort = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
export const labPort = () => envPort("WHISPER_LAB_PORT", CONFIG.port);
/** Each model keeps its own port (catalog order), whether or not the others are installed. */
export const modelPort = (m) => envPort("WHISPER_LAB_MODEL_PORT", CONFIG.firstModelPort) + MODELS.indexOf(m);

export function threads() {
  const n = Number(process.env.WHISPER_LAB_THREADS) || CONFIG.threads;
  return n > 0 ? n : Math.min(8, availableParallelism());
}

/** A model is installed when its file and its engine's program are both there. */
export function installed(m, p = paths()) {
  const engine = m.engine === "transcribe" ? p.transcribeHost : p.whisperServer;
  return existsSync(join(p.models, m.file)) && existsSync(engine);
}

/** "all", or a comma list of ids → catalog entries; throws on an unknown id. */
export function select(list) {
  if (!list || list === "all") return MODELS;
  const ids = list.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !MODELS.some((m) => m.id === id));
  if (unknown.length) throw new Error(`unknown model id(s): ${unknown.join(", ")}; known: ${MODELS.map((m) => m.id).join(", ")}`);
  return MODELS.filter((m) => ids.includes(m.id));
}

// ---- CLI (tab-separated lines, for the shell scripts) ---------------------------------------

function pin(path) {
  const v = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), PINS);
  if (v === undefined || typeof v === "object") throw new Error(`no pin ${path}`);
  return String(v);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  const line = (...xs) => console.log(xs.join("\t"));
  try {
    if (cmd === "state") line(stateDir());
    else if (cmd === "pin") line(pin(arg));
    else if (cmd === "lab-port") line(labPort());
    else if (cmd === "threads") line(threads());
    else if (cmd === "select") for (const m of select(arg)) line(m.id, m.engine, m.file, m.bytes, m.sha256, m.url, m.label);
    else if (cmd === "all") for (const m of MODELS) line(m.id, modelPort(m), m.engine, m.file);
    else if (cmd === "installed") for (const m of MODELS.filter((x) => installed(x))) line(m.id, modelPort(m), m.engine, m.file);
    else {
      console.error("usage: catalog.mjs state | pin <key.path> | lab-port | threads | select <all|id,id> | all | installed");
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
