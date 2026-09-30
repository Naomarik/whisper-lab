// whisper-lab page. Relative URLs only, so it works at http://localhost:8850/ and under a path
// prefix behind a reverse proxy. Sentence sets and jargon come from the server (sentences.json and
// config.json in the repo).

if (!location.pathname.endsWith("/") && !location.pathname.endsWith(".html")) {
  location.replace(`${location.pathname}/${location.search}${location.hash}`);
}

const $ = (id) => document.getElementById(id);
const TARGET_RATE = 16000;
const words = (s) => (s || "").split(/\s+/).filter(Boolean);
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

const config = await fetch("api/config")
  .then((r) => r.json())
  .catch(() => ({ sets: { default: { sentences: [], jargon: [] } }, defaultReference: null }));
const SET_NAMES = Object.keys(config.sets);
const SET = config.sets[localStorage.getItem("whisperlab.set")] ? localStorage.getItem("whisperlab.set") : SET_NAMES[0];

const state = {
  backends: [], // from api/backends: the installed models
  enabled: JSON.parse(localStorage.getItem("whisperlab.enabled") || "{}"),
  rows: new Map(),
  refId: localStorage.getItem("whisperlab.ref") || config.defaultReference,
  sequential: localStorage.getItem("whisperlab.sequential") === "1",
  clipId: null,
  recording: null,
};

// ---- reference sentences ---------------------------------------------------------------------------

const SENTENCES = config.sets[SET].sentences.length ? config.sets[SET].sentences : ["(this sentence set is empty)"];
// Words scored in the Jargon column, from every set (normalized with norm(): lower case, punctuation stripped).
const JARGON = new Set(Object.values(config.sets).flatMap((s) => s.jargon).map(norm));
const isJargon = (w) => JARGON.has(norm(w));

// The reference is always a listed sentence; only a loaded saved clip can override it: with its own
// sentence (not in SENTENCES, shown read-only) or with none (the reference-row radio).
const saved = localStorage.getItem("whisperlab.reference");
state.sentence = SENTENCES.includes(saved) ? saved : SENTENCES[0];
state.reference = state.sentence;

function selectSentence(text) {
  state.sentence = text;
  localStorage.setItem("whisperlab.reference", text);
  setReference(text);
}

// From a saved clip: a listed sentence selects it; anything else (custom or "") applies to this clip only.
function setReference(text) {
  if (SENTENCES.includes(text.trim())) {
    state.sentence = text.trim();
    localStorage.setItem("whisperlab.reference", state.sentence);
  }
  state.reference = text;
  renderReference();
  render();
}

// Before a new recording or file: back to the selected sentence.
function useSentence() {
  if (state.reference !== state.sentence) setReference(state.sentence);
}

function renderReference() {
  const text = state.reference.trim();
  const listed = SENTENCES.includes(text);
  const rt = $("readthis");
  rt.innerHTML = "";
  rt.classList.toggle("empty", !text);
  if (!text) rt.textContent = "(this saved clip has no sentence: WER is measured against the reference row you pick below)";
  for (const w of words(text)) {
    const s = document.createElement("span");
    s.textContent = w;
    if (isJargon(w)) s.className = "jargon";
    rt.append(s, " ");
  }
  $("refnote").textContent = listed ? "" : text ? "saved clip's own sentence (read-only); pick one below to go back" : "";
  const i = SENTENCES.indexOf(listed ? text : state.sentence);
  $("counter").textContent = `${i + 1} / ${SENTENCES.length}`;
  for (const b of $("sentences").querySelectorAll("button")) b.classList.toggle("on", listed && b.dataset.text === text);
  $("refhint").textContent = text
    ? "Every row is diffed against the sentence: highlighted = wrong, struck = missing, orange = extra. Jargon = sentence jargon words the row got right."
    : "Reference row: pick with the radio; differing words are highlighted, WER vs reference.";
}

SENTENCES.forEach((t, i) => {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.dataset.text = t;
  b.textContent = `${i + 1}. ${t}`;
  b.onclick = () => selectSentence(t);
  li.append(b);
  $("sentences").append(li);
});
const step = (d) => selectSentence(SENTENCES[(SENTENCES.indexOf(state.sentence) + d + SENTENCES.length) % SENTENCES.length]);
$("next").onclick = () => step(1);
$("prev").onclick = () => step(-1);
$("allsentences").open = matchMedia("(min-width: 700px)").matches;
$("set").hidden = SET_NAMES.length < 2;
for (const n of SET_NAMES) $("set").append(new Option(`${n} sentences`, n));
$("set").value = SET;
$("set").onchange = () => {
  localStorage.setItem("whisperlab.set", $("set").value);
  location.reload();
};

// ---- setup -------------------------------------------------------------------------------------

$("where").textContent = `${location.origin}${location.pathname}`;

$("proc").checked = localStorage.getItem("whisperlab.proc") === "1";
$("proc").onchange = () => localStorage.setItem("whisperlab.proc", $("proc").checked ? "1" : "0");
$("mic").onchange = () => localStorage.setItem("whisperlab.mic", $("mic").value);

/** The mic list (labels and ids appear once the page has had mic access). */
async function listMics() {
  const sel = $("mic");
  const keep = sel.value || localStorage.getItem("whisperlab.mic") || "";
  const devs = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? [];
  sel.length = 1;
  for (const d of devs) if (d.kind === "audioinput" && d.deviceId && d.deviceId !== "default") sel.append(new Option(d.label || `mic ${sel.length}`, d.deviceId));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}
navigator.mediaDevices?.addEventListener("devicechange", listMics);

const silenceNote = (s) => (s ? `digital zeros ${s.zeroPct}% · longest zero run in speech ${s.longestZeroMs} ms${s.flagged ? (s.longestZeroMs >= 10 ? " ⚠ gated" : " ⚠ zeroed") : ""}` : "");

async function loadEE() {
  const ee = await fetch("api/easyeffects").then((r) => r.json()).catch(() => ({}));
  $("ee").hidden = !ee.available;
  $("ee").title = ee.reason ?? "";
  if (!ee.available) return;
  $("eepreset").length = 0;
  for (const p of ee.presets.includes(ee.preset) ? ee.presets : [ee.preset, ...ee.presets]) $("eepreset").append(new Option(p === ee.preset ? `${p} (current)` : p, p));
  $("eepreset").value = ee.preset;
}

$("sequential").checked = state.sequential;
$("sequential").onchange = () => {
  state.sequential = $("sequential").checked;
  localStorage.setItem("whisperlab.sequential", state.sequential ? "1" : "0");
};

async function loadBackends() {
  let server = [];
  try {
    server = await (await fetch("api/backends")).json();
  } catch (err) {
    setStatus(`api/backends failed: ${err.message}`);
  }
  state.backends = server;
  if (!server.some((b) => b.id === state.refId)) state.refId = server[0]?.id ?? null;
  const box = $("backends");
  box.innerHTML = "";
  for (const b of state.backends) {
    if (state.enabled[b.id] === undefined) state.enabled[b.id] = true;
    const l = document.createElement("label");
    l.className = `be${b.ready ? "" : " off"}`;
    l.title = b.ready ? (b.note ?? "") : b.reason;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = b.ready && state.enabled[b.id];
    cb.disabled = !b.ready;
    cb.onchange = () => {
      state.enabled[b.id] = cb.checked;
      localStorage.setItem("whisperlab.enabled", JSON.stringify(state.enabled));
    };
    l.append(cb, ` ${b.label} `);
    const k = document.createElement("span");
    k.className = "muted";
    k.textContent = b.ready ? `(${b.kind})` : `— ${b.reason}`;
    l.append(k);
    box.append(l);
  }
  $("rec").disabled = false;
  setStatus("ready");
}

async function loadClips(selectId) {
  let clips = [];
  try {
    clips = await (await fetch("api/clips")).json();
  } catch {}
  const sel = $("clips");
  sel.innerHTML = `<option value="">— saved clips (${clips.length}) —</option>`;
  for (const c of clips) {
    const o = document.createElement("option");
    o.value = c.id;
    const hint = c.label || "";
    o.textContent = `${c.id} · ${c.audioSec}s${c.silence?.flagged ? " · ⚠ zeros" : ""}${hint ? ` · ${hint.slice(0, 60)}` : ""}`;
    sel.append(o);
  }
  if (selectId) sel.value = selectId;
  $("rerun").disabled = $("replay").disabled = !sel.value;
}

$("clips").onchange = async () => {
  const id = $("clips").value;
  $("rerun").disabled = $("replay").disabled = !id;
  if (!id) return;
  $("player").src = `api/clips/${id}`;
  const meta = await (await fetch(`api/clips/${id}/meta`)).json();
  setReference(typeof meta.reference === "string" ? meta.reference : "");
  $("clipinfo").textContent = `clip ${id} · ${meta.audioSec}s · ${silenceNote(meta.silence)}`;
  if (Array.isArray(meta.results)) {
    state.clipId = id;
    state.rows = new Map(meta.results.map((r) => [r.id, r]));
    $("clipinfo").textContent += ` · saved results from ${meta.resultsAt ?? "?"}`;
    render();
  }
};

function setStatus(s) {
  $("status").textContent = s;
}

// ---- audio helpers -------------------------------------------------------------------------------

/** Float32 chunks at `rate` → Float32 mono at 16 kHz (OfflineAudioContext does the filtering). */
async function resampleTo16k(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  if (!n) return new Float32Array(0);
  const buf = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
  const data = buf.getChannelData(0);
  let o = 0;
  for (const c of chunks) {
    data.set(c, o);
    o += c.length;
  }
  if (rate === TARGET_RATE) return data.slice();
  const off = new OfflineAudioContext(1, Math.ceil((n * TARGET_RATE) / rate), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

/** Any encoded audio → Float32 mono 16 kHz (decodeAudioData resamples to the context's rate). */
async function decodeTo16k(arrayBuffer) {
  const off = new OfflineAudioContext(1, 1, TARGET_RATE);
  const ab = await off.decodeAudioData(arrayBuffer);
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

function encodeWav(f32, rate = TARGET_RATE) {
  const buf = new ArrayBuffer(44 + f32.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + f32.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---- fan-out ------------------------------------------------------------------------------------------

function setRow(id, patch) {
  const b = state.backends.find((x) => x.id === id);
  const prev = state.rows.get(id) ?? { id, label: b?.label ?? id, kind: b?.kind };
  state.rows.set(id, { ...prev, ...patch });
  render();
}

/** One backend on one clip → its row. */
async function runOne(b, wav, audioSec, set) {
  setRow(b.id, { pending: "running…", audioSec });
  const t0 = performance.now();
  try {
    const res = await fetch(`api/transcribe/${b.id}?set=${encodeURIComponent(set)}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    const rtt = Math.round(performance.now() - t0);
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (j.error) return setRow(b.id, { pending: null, error: j.error, ms: j.wallMs, audioSec: j.audioSec ?? audioSec, notes: `page round trip ${rtt} ms` });
    setRow(b.id, { pending: null, error: null, text: j.text, ms: j.ms, audioSec: j.audioSec, notes: `${j.notes}; page round trip ${rtt} ms` });
  } catch (err) {
    setRow(b.id, { pending: null, error: err.message });
  }
}

/**
 * Run every enabled model on one clip: all at once (they share the GPU), or one at a time so each
 * latency is uncontended. `wav` is the 16 kHz mono WAV Blob; `clipId` a clip id or a promise of
 * one (results are saved to it once everything is in); `set` the sentence set whose prompt whisper gets.
 */
async function runAll({ wav, audioSec, clipId, label, set = SET }) {
  state.rows = new Map();
  state.clipId = null;
  const mode = state.sequential ? "one at a time" : "parallel";
  $("clipinfo").textContent = `${label} · ${audioSec.toFixed(1)} s · ${wav.size} B WAV · ${mode}`;
  const run = state.backends.filter((b) => b.ready && state.enabled[b.id]);
  for (const b of run) setRow(b.id, { pending: state.sequential ? "waiting…" : "running…", audioSec });
  const t0 = performance.now();
  if (state.sequential) for (const b of run) await runOne(b, wav, audioSec, set);
  else await Promise.allSettled(run.map((b) => runOne(b, wav, audioSec, set)));
  const total = Math.round(performance.now() - t0);
  $("clipinfo").textContent += ` · all ${run.length} in ${total} ms`;
  state.clipId = (await clipId) ?? null;
  if (state.clipId) {
    const meta = await fetch(`api/clips/${state.clipId}/meta`).then((r) => r.json()).catch(() => ({}));
    if (meta.silence) $("clipinfo").textContent += ` · ${silenceNote(meta.silence)}`;
    fetch(`api/clips/${state.clipId}/results`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ results: [...state.rows.values()], reference: state.reference.trim() }) }).catch(() => {});
  }
  setStatus("done");
}

// ---- recording ----------------------------------------------------------------------------------------

async function startRecording() {
  useSentence();
  let stream;
  const proc = $("proc").checked;
  const audio = { channelCount: 1, echoCancellation: proc, noiseSuppression: proc, autoGainControl: proc };
  if ($("mic").value) audio.deviceId = { exact: $("mic").value };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    setStatus(`microphone refused: ${err.message}${window.isSecureContext ? "" : " — the mic needs HTTPS or localhost"}`);
    return;
  }
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  const chunks = [];
  node.port.onmessage = ({ data }) => {
    chunks.push(data.pcm);
    $("level").style.width = `${Math.min(100, data.rms * 400)}%`;
  };
  const t0 = performance.now();
  const timer = setInterval(() => ($("timer").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100);
  const capture = `mic ${stream.getAudioTracks()[0]?.label || "default"} · processing ${proc ? "on" : "off"}`;
  state.recording = { stream, ctx, node, chunks, timer, capture };
  listMics();
  $("rec").textContent = "■ Stop";
  $("rec").classList.add("on");
  setStatus(`recording at ${ctx.sampleRate} Hz…`);
}

async function stopRecording() {
  const r = state.recording;
  state.recording = null;
  $("rec").textContent = "● Record";
  $("rec").classList.remove("on");
  $("rec").disabled = true;
  setStatus("post-roll…");
  await new Promise((res) => setTimeout(res, 350)); // keep the last word
  clearInterval(r.timer);
  $("level").style.width = "0";
  r.node.port.postMessage("flush");
  await new Promise((res) => setTimeout(res, 60));
  r.stream.getTracks().forEach((t) => t.stop());
  const rate = r.ctx.sampleRate;
  await r.ctx.close();
  setStatus("encoding…");
  const f32 = await resampleTo16k(r.chunks, rate);
  const wav = encodeWav(f32);
  $("rec").disabled = false;
  setStatus("transcribing…");
  const saved = saveClip(wav, r.capture).catch(() => null);
  await runAll({ wav, audioSec: f32.length / TARGET_RATE, clipId: saved, label: `recording (${r.capture})` });
  const id = await saved;
  loadClips(id);
  if (id) $("player").src = `api/clips/${id}`;
}

async function saveClip(wav, label) {
  const meta = {};
  if (label) meta.label = label;
  if (state.reference.trim()) meta.reference = state.reference.trim();
  meta.set = SET;
  const res = await fetch(`api/clips?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  if (!res.ok) throw new Error(`save failed ${res.status}`);
  return (await res.json()).id;
}

$("rec").onclick = () => (state.recording ? stopRecording() : startRecording());

async function rerun(id, label) {
  setStatus(`running ${id}…`);
  const meta = await fetch(`api/clips/${id}/meta`).then((r) => r.json()).catch(() => ({}));
  setReference(typeof meta.reference === "string" ? meta.reference : "");
  const bytes = await fetch(`api/clips/${id}`).then((r) => r.arrayBuffer());
  const wav = new Blob([bytes], { type: "audio/wav" });
  const f32 = await decodeTo16k(bytes.slice(0));
  await runAll({ wav, audioSec: f32.length / TARGET_RATE, clipId: id, label, set: meta.set ?? "default" });
}

$("rerun").onclick = () => $("clips").value && rerun($("clips").value, `re-run ${$("clips").value}`);

$("replay").onclick = async () => {
  const id = $("clips").value;
  if (!id) return;
  $("replay").disabled = true;
  setStatus(`replaying ${id} through EasyEffects (${$("eepreset").value})…`);
  try {
    const res = await fetch(`api/clips/${id}/replay?preset=${encodeURIComponent($("eepreset").value)}`, { method: "POST" });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    await loadClips(j.id);
    $("player").src = `api/clips/${j.id}`;
    await rerun(j.id, `${j.label} (offset ${j.offsetMs} ms)`);
  } catch (err) {
    setStatus(`replay failed: ${err.message}`);
  }
  $("replay").disabled = !$("clips").value;
};

$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  useSentence();
  setStatus(`decoding ${f.name}…`);
  const f32 = await decodeTo16k(await f.arrayBuffer());
  const wav = encodeWav(f32);
  const clipId = await saveClip(wav, f.name).catch(() => null);
  await runAll({ wav, audioSec: f32.length / TARGET_RATE, clipId, label: `file ${f.name}` });
  loadClips(clipId);
};

// ---- diff + table ---------------------------------------------------------------------------------------

/** Word-level Levenshtein alignment of hyp against ref → {ops, wer}. */
function align(refText, hypText) {
  const ref = words(refText);
  const hyp = words(hypText);
  const R = ref.map(norm);
  const H = hyp.map(norm);
  const d = Array.from({ length: R.length + 1 }, (_, i) => Array.from({ length: H.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= R.length; i++) {
    for (let j = 1; j <= H.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (R[i - 1] === H[j - 1] ? 0 : 1));
    }
  }
  const ops = [];
  let i = R.length;
  let j = H.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (R[i - 1] === H[j - 1] ? 0 : 1)) {
      ops.push(R[i - 1] === H[j - 1] ? ["eq", hyp[j - 1], ref[i - 1]] : ["sub", hyp[j - 1], ref[i - 1]]);
      i--;
      j--;
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      ops.push(["ins", hyp[j - 1]]);
      j--;
    } else {
      ops.push(["del", null, ref[i - 1]]);
      i--;
    }
  }
  ops.reverse();
  return { ops, wer: R.length ? d[R.length][H.length] / R.length : null };
}

function diffNode(ops) {
  const span = document.createElement("span");
  for (const [op, w, r] of ops) {
    let el;
    if (op === "eq") el = document.createTextNode(w);
    else if (op === "sub") {
      el = document.createElement("mark");
      el.textContent = w;
      el.title = `reference: ${r}`;
    } else if (op === "ins") {
      el = document.createElement("mark");
      el.className = "ins";
      el.textContent = w;
      el.title = "not in reference";
    } else {
      el = document.createElement("del");
      el.textContent = r;
      el.title = "missing (in reference)";
    }
    span.append(el, " ");
  }
  return span;
}

function render() {
  const tb = $("results");
  tb.innerHTML = "";
  const sentence = state.reference.trim();
  const refRowId = sentence ? null : state.refId; // with a sentence set, no row is the reference
  const ref = state.rows.get(state.refId);
  const refText = sentence || (ref && !ref.error && !ref.pending ? ref.text : null);
  const jargonTotal = sentence ? words(sentence).filter(isJargon).length : 0;
  for (const row of state.rows.values()) {
    const tr = document.createElement("tr");
    if (row.id === refRowId) tr.className = "ref";
    const cell = (text, cls) => {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      if (text instanceof Node) td.append(text);
      else td.textContent = text ?? "";
      tr.append(td);
      return td;
    };
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "ref";
    radio.checked = row.id === refRowId;
    radio.disabled = !!sentence;
    radio.title = sentence ? "clear the sentence to use a reference row" : "use this row as the reference";
    radio.onchange = () => {
      state.refId = row.id;
      localStorage.setItem("whisperlab.ref", row.id);
      render();
    };
    cell(radio);
    cell(row.label);
    let wer = "";
    let jargon = "";
    if (row.pending) cell(row.pending, "txt pending");
    else if (row.error) cell(row.error, "txt err");
    else if (!row.text) {
      cell("(empty transcript)", "txt err");
      wer = row.id === refRowId ? "" : "100%";
      if (jargonTotal) jargon = `0/${jargonTotal}`;
    }
    else if (refText != null && row.id !== refRowId) {
      const a = align(refText, row.text);
      cell(diffNode(a.ops), "txt");
      wer = a.wer == null ? "" : `${(a.wer * 100).toFixed(0)}%`;
      if (jargonTotal) jargon = `${a.ops.filter(([op, , r]) => op === "eq" && isJargon(r)).length}/${jargonTotal}`;
    } else cell(row.text, "txt");
    cell(row.id === refRowId ? "ref" : wer, "num");
    cell(jargon, "num");
    cell(row.ms != null ? String(row.ms) : "", "num");
    cell(row.audioSec != null ? row.audioSec.toFixed(1) : "", "num");
    cell(row.notes ?? "", "notes");
    tb.append(tr);
  }
}

renderReference();
loadBackends();
loadClips();
listMics();
loadEE();
