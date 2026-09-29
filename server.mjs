#!/usr/bin/env node
// whisper-lab server: serves the page (public/) and the transcription fan-out API on
// 127.0.0.1:<config.json port, or $WHISPER_LAB_PORT>. Node builtins only. The page uses relative
// URLs, so it also works under a path prefix behind a reverse proxy.
//
//   GET  /api/health
//   GET  /api/config                    {sentences, jargon, defaultReference}
//   GET  /api/backends                  [{id,label,kind,ready,reason?,note?}] (installed models only)
//   POST /api/transcribe/:backend       body: 16 kHz mono WAV → {text, ms, wallMs, audioSec, bytes, notes}
//   POST /api/clips?meta=<json>         body: WAV → {id}
//   GET  /api/clips                     [{id, created, audioSec, bytes, label?, reference?, hasResults}]
//   GET  /api/clips/:id                 the WAV
//   GET  /api/clips/:id/meta            the metadata (incl. saved results)
//   PUT  /api/clips/:id/results         body: JSON results table, or {results, reference} → {ok}
//
// Clips live in <state dir>/clips. Logs carry method, path, status and time only.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, REPO, SENTENCES, labPort, paths } from "./lib/catalog.mjs";
import { backends, parseWav } from "./lib/backends.mjs";

const PUBLIC = join(REPO, "public");
const CLIPS = paths().clips;
const PORT = labPort();
const MAX_BODY = 50 * 1024 * 1024;

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/lab.js": ["lab.js", "text/javascript; charset=utf-8"],
  "/worklet.js": ["worklet.js", "text/javascript; charset=utf-8"],
};

const CLIP_ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(Object.assign(new Error(`body over ${MAX_BODY / 1048576} MB`), { status: 413 }));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function backendInfo(b) {
  let st;
  try {
    st = await b.status();
  } catch (err) {
    st = { ready: false, reason: err.message };
  }
  const info = { id: b.id, label: b.label, kind: b.kind, ready: !!st.ready };
  if (st.reason) info.reason = st.reason;
  if (st.note) info.note = st.note;
  return info;
}

async function transcribe(b, wav) {
  let clip;
  try {
    clip = parseWav(wav);
  } catch (err) {
    return [400, { backend: b.id, error: err.message }];
  }
  const t0 = performance.now();
  try {
    const r = await b.transcribe(wav, clip);
    const wallMs = Math.round(performance.now() - t0);
    return [200, { backend: b.id, text: r.text, ms: r.ms ?? wallMs, wallMs, audioSec: +clip.audioSec.toFixed(2), bytes: r.bytes ?? wav.length, notes: r.notes ?? "" }];
  } catch (err) {
    return [502, { backend: b.id, error: err.message, wallMs: Math.round(performance.now() - t0), audioSec: +clip.audioSec.toFixed(2) }];
  }
}

function newClipId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

const metaPath = (id) => join(CLIPS, `${id}.json`);
const readMeta = (id) => {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8"));
  } catch {
    return { id };
  }
};

async function route(req, res, url) {
  const path = url.pathname;
  const m = req.method;

  if (m === "GET" && STATIC[path]) {
    const [file, type] = STATIC[path];
    const full = join(PUBLIC, file);
    if (!existsSync(full)) return send(res, 404, { error: "not found" });
    return send(res, 200, readFileSync(full), type);
  }
  if (m === "GET" && path === "/api/health") return send(res, 200, { ok: true });
  if (m === "GET" && path === "/api/config") {
    return send(res, 200, { sentences: SENTENCES, jargon: CONFIG.jargon ?? [], defaultReference: CONFIG.defaultReference ?? null });
  }
  if (m === "GET" && path === "/api/backends") return send(res, 200, await Promise.all(backends().map(backendInfo)));

  let r;
  if (m === "POST" && (r = /^\/api\/transcribe\/([\w.-]+)$/.exec(path))) {
    const b = backends().find((x) => x.id === r[1]);
    if (!b) return send(res, 404, { error: `unknown or uninstalled model ${r[1]}` });
    const [status, body] = await transcribe(b, await readBody(req));
    return send(res, status, body);
  }

  if (m === "POST" && path === "/api/clips") {
    const wav = await readBody(req);
    let clip;
    try {
      clip = parseWav(wav);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    let extra = {};
    try {
      extra = JSON.parse(url.searchParams.get("meta") || "{}");
    } catch {}
    mkdirSync(CLIPS, { recursive: true });
    const id = newClipId();
    writeFileSync(join(CLIPS, `${id}.wav`), wav);
    const meta = { id, created: new Date().toISOString(), audioSec: +clip.audioSec.toFixed(2), bytes: wav.length, sampleRate: clip.sampleRate };
    if (typeof extra.label === "string") meta.label = extra.label.slice(0, 200);
    if (typeof extra.reference === "string" && extra.reference.trim()) meta.reference = extra.reference.trim().slice(0, 1000);
    writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
    return send(res, 201, { id, audioSec: meta.audioSec });
  }
  if (m === "GET" && path === "/api/clips") {
    if (!existsSync(CLIPS)) return send(res, 200, []);
    const ids = readdirSync(CLIPS)
      .filter((f) => f.endsWith(".wav"))
      .map((f) => f.slice(0, -4))
      .filter((id) => CLIP_ID_RE.test(id))
      .sort()
      .reverse();
    return send(
      res,
      200,
      ids.map((id) => {
        const { results, ...meta } = readMeta(id);
        return { ...meta, bytes: meta.bytes ?? statSync(join(CLIPS, `${id}.wav`)).size, hasResults: !!results };
      }),
    );
  }
  if ((r = /^\/api\/clips\/([^/]+)(\/meta|\/results)?$/.exec(path))) {
    const id = r[1];
    if (!CLIP_ID_RE.test(id) || !existsSync(join(CLIPS, `${id}.wav`))) return send(res, 404, { error: "no such clip" });
    if (m === "GET" && !r[2]) return send(res, 200, readFileSync(join(CLIPS, `${id}.wav`)), "audio/wav");
    if (m === "GET" && r[2] === "/meta") return send(res, 200, readMeta(id));
    if (m === "PUT" && r[2] === "/results") {
      let results;
      try {
        results = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        return send(res, 400, { error: "results must be JSON" });
      }
      const meta = readMeta(id);
      // Body: the results array, or {results, reference} (reference: the sentence read aloud).
      if (!Array.isArray(results) && results && typeof results === "object") {
        const { reference } = results;
        results = results.results;
        if (typeof reference === "string" && reference.trim()) meta.reference = reference.trim().slice(0, 1000);
        else delete meta.reference;
      }
      meta.results = results;
      meta.resultsAt = new Date().toISOString();
      writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const t0 = performance.now();
  const url = new URL(req.url, "http://localhost");
  try {
    await route(req, res, url);
  } catch (err) {
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
  }
  if (url.pathname.startsWith("/api/")) {
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`);
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`whisper-lab on http://127.0.0.1:${PORT}/`));
