// One backend per installed model, each its own local server started by lab.sh. Both engines
// answer /health and /inference: whisper.cpp's whisper-server, and native/transcribe-host.c for
// Parakeet. whisper gets temperature 0, greedy, no VAD, and config.json's `prompt` as its
// initial prompt (the vocabulary hint); the transcribe host gets the bare WAV (Parakeet takes no
// prompt).
//
// A backend is { id, label, kind, status(): Promise<{ready, note?, reason?}>, transcribe(wav) }.

import { CONFIG, MODELS, installed, modelPort, paths } from "./catalog.mjs";

/** Short excerpt of a response body for an error message. */
export const excerpt = (text, n = 300) => String(text).replace(/\s+/g, " ").trim().slice(0, n);

/** 16-bit PCM WAV → { pcm (mono Int16), sampleRate, audioSec }. Stereo is down-mixed. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("body is not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`WAV must be 16-bit PCM (got format ${fmt.format}, ${fmt.bits} bit)`);
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE(body + (i * fmt.channels + c) * 2);
        pcm[i] = Math.round(s / fmt.channels);
      }
      return { pcm, sampleRate: fmt.sampleRate, audioSec: frames / fmt.sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

function serverBackend(m) {
  const port = modelPort(m);
  const base = `http://127.0.0.1:${port}`;
  const server = m.engine === "transcribe" ? "transcribe-host" : "whisper-server";
  return {
    id: m.id,
    label: m.label,
    kind: m.engine,
    async status() {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await res.text();
        if (res.ok) return { ready: true, note: `${m.file} @ 127.0.0.1:${port}` };
        return { ready: false, reason: `${server} on ${port} answered ${res.status}: ${excerpt(body, 80)}` };
      } catch {
        return { ready: false, reason: `${server} not running on 127.0.0.1:${port}; run ./lab.sh start` };
      }
    },
    async transcribe(wav) {
      let init;
      if (m.engine === "transcribe") {
        init = { method: "POST", body: wav, headers: { "Content-Type": "audio/wav" } };
      } else {
        const fd = new FormData();
        fd.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");
        fd.append("temperature", "0");
        fd.append("response_format", "json");
        if (CONFIG.prompt) fd.append("prompt", CONFIG.prompt);
        init = { method: "POST", body: fd };
      }
      const res = await fetch(`${base}/inference`, init);
      const body = await res.text();
      if (!res.ok) throw new Error(`${server} ${res.status}: ${excerpt(body)}`);
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`${server} returned non-JSON: ${excerpt(body)}`);
      }
      if (json.error) throw new Error(`${server}: ${excerpt(json.error)}`);
      return {
        text: String(json.text ?? "").replace(/\s+/g, " ").trim(),
        bytes: wav.length,
        notes: m.engine === "transcribe" ? `${m.file}, transcribe.cpp, no prompt` : `${m.file}, whisper.cpp, prompt from config.json`,
      };
    },
  };
}

/** The installed models' backends, in catalog order (re-read per call: installs can happen while the lab runs). */
export function backends() {
  const p = paths();
  return MODELS.filter((m) => installed(m, p)).map(serverBackend);
}
