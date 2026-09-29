# whisper-lab

Record one clip in the browser and compare local speech-to-text models on it. You read a
sentence aloud, and every installed model transcribes the same recording. The table shows each
transcript word-diffed against the sentence, with word error rate (WER), a jargon score and
latency.

The models:

| id | Model | Engine | Languages | Download | GPU memory* |
|---|---|---|---|---|---|
| `turbo-q5_0` | Whisper large-v3-turbo, q5_0 | whisper.cpp | multilingual | 574 MB | ~0.85 GB |
| `parakeet-v2` | NVIDIA Parakeet TDT 0.6B v2, q8_0 | transcribe.cpp | English | 730 MB | ~0.7 GB |
| `turbo-q8_0` | Whisper large-v3-turbo, q8_0 | whisper.cpp | multilingual | 874 MB | ~1.1 GB |
| `large-v3-q5_0` | Whisper large-v3, q5_0 | whisper.cpp | multilingual | 1.08 GB | ~1.6 GB |
| `distil-large-v3.5` | distil-large-v3.5, f16 | whisper.cpp | English | 1.52 GB | ~1.7 GB |
| `turbo-f16` | Whisper large-v3-turbo, f16 | whisper.cpp | multilingual | 1.62 GB | ~1.8 GB |

All six come to about 6.4 GB on disk, plus Silero VAD (0.9 MB), about 90 MB for transcribe.cpp,
and about 500 MB of temporary space while whisper.cpp builds.

\* GPU memory is what one model's server held once loaded, measured on one AMD iGPU with Vulkan.
All six running at once used about 7.7 GB. Other GPUs and backends will differ.

Latency, measured on that same iGPU with an 8-second clip, warm, one model at a time: Parakeet
65–100 ms, the turbo variants and distil-large-v3.5 320–390 ms, large-v3 q5_0 590–710 ms. With
every model running in parallel they share the GPU, so each takes roughly 3–4 times longer.

## Requirements

Linux is the tested platform. macOS paths are portable, but the Metal build is untested.

Everything needs:

- bash, curl, tar, and `sha256sum` or `shasum`
- Node.js 20 or newer (it runs the lab; no npm packages)
- cmake and a C/C++ compiler (gcc/g++ or clang), to build whisper.cpp
- a browser with microphone access

On top of that, for the GPU backend (install.sh detects it; `WHISPER_LAB_BACKEND` forces one):

| Backend | Detected when | Also needs |
|---|---|---|
| Vulkan (AMD, Intel, NVIDIA) | `glslc` and the Vulkan headers are present | a Vulkan driver. Debian/Ubuntu: `libvulkan-dev glslc`; Fedora: `vulkan-loader-devel glslc`; Arch: `vulkan-headers vulkan-icd-loader shaderc` |
| CUDA (NVIDIA) | `nvcc` is on `PATH` or in `/usr/local/cuda/bin` | the CUDA toolkit |
| Metal (macOS) | macOS | Xcode command line tools (untested) |
| CPU | none of the above | nothing more; expect several seconds per clip |

Parakeet runs on transcribe.cpp's prebuilt library, which exists for **Linux x86_64 only**.
install.sh compiles a small HTTP host (`native/transcribe-host.c`) against it. That needs a C
compiler. Without one, or on another platform, install.sh skips Parakeet with a message and
installs the rest. The library uses Vulkan when it's available and falls back to the CPU.

## Install

```sh
git clone <this repo> whisper-lab
cd whisper-lab
./install.sh                                  # everything (~6.4 GB of models)
./install.sh --models turbo-q5_0,parakeet-v2  # or just some
```

install.sh prints the disk each model needs, then does the following:

- builds whisper.cpp v1.9.4 (`whisper-server`) from the release tarball for the detected backend
- downloads each model and Silero VAD from Hugging Face, checking size and sha256
- sets up transcribe.cpp v0.2.4 for Parakeet

It's safe to re-run. Downloads resume, files already present are re-verified, and a built
server is kept unless you pass `--rebuild`.

Everything goes to the state dir, never the repo: `$WHISPER_LAB_HOME`, else
`$XDG_CACHE_HOME/whisper-lab`, else `~/.cache/whisper-lab`. To uninstall, delete that dir.

## Run

```sh
./lab.sh start     # the page on 127.0.0.1:8850, one model server per installed model on 8851+
./lab.sh status
./lab.sh stop
```

Open <http://127.0.0.1:8850/>. Only installed models show up as rows.

- Pick a sentence with **Previous** / **Next**, or from the full list, and press **Record**.
  Read it aloud, then press **Stop**. Every model gets the clip.
- **one at a time** runs the models one after another, so each latency is uncontended. When it's
  off, they all run in parallel.
- Each row is diffed against the sentence. Highlighted words are wrong, struck words are
  missing, and orange words are extra. **WER** is the word error rate. **Jargon** counts how
  many of the sentence's jargon words (dotted underline) the model got right.
- Every recording is saved with its sentence and results in `<state dir>/clips`. Pick one under
  **Re-run a saved clip** to play it, see its saved results, or run it again. You can also load
  an audio file.

Ports: `port` and `firstModelPort` in `config.json`, or `WHISPER_LAB_PORT` and
`WHISPER_LAB_MODEL_PORT`. Each model keeps a fixed offset (catalog order), so its port doesn't
change when you install more. Logs and pids are in `<state dir>/run`.
`WHISPER_LAB_NO_GPU=1 ./lab.sh start` runs every model on the CPU.

## Customize

- `sentences.json`: the sentences to read aloud (a JSON array of strings).
- `config.json`:
  - `jargon`: the words scored in the Jargon column (case and punctuation are ignored)
  - `prompt`: whisper's initial prompt. Whisper has no hotword list, but a prompt that contains
    the words biases it toward spelling them that way. Parakeet takes no prompt.
  - `port`, `firstModelPort`, `threads` (0 means min(8, CPUs)), and `defaultReference` (the
    reference row when a clip has no sentence)
- `models.json`: the pinned downloads (URLs, sizes, sha256).

## Using it from a phone

The lab listens on 127.0.0.1 only. Browsers allow the microphone only on HTTPS pages or on
`localhost`, so a phone needs an HTTPS URL that forwards to the lab. Any of these works:

- a reverse proxy (Caddy, nginx, …) with a certificate, forwarding to `http://127.0.0.1:8850`.
  The page uses relative URLs, so a path prefix works too.
- `tailscale serve`, if you use Tailscale: it gives the machine an HTTPS name inside your
  tailnet.
- a self-signed certificate on a reverse proxy. The phone has to trust it, or you click through
  the warning.

Don't expose the lab to the public internet. It has no authentication, and it stores whatever
it records.

## How it works

`server.mjs` (Node, no dependencies) serves `public/` and a small JSON API. It fans each clip out
to the model servers that `lab.sh` started. Those are whisper.cpp's `whisper-server`, and
`transcribe-host` for Parakeet. Both answer `GET /health` and `POST /inference` with a 16 kHz
mono WAV. Whisper decodes greedily at temperature 0, with `config.json`'s prompt and no VAD. The
page records through an AudioWorklet and resamples to 16 kHz in the browser.

## Credits

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) by Georgi Gerganov and
  contributors: the Whisper engine and the GGML model conversions
- [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) and its GGUF
  conversion of Parakeet: the Parakeet engine
- [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (CC-BY-4.0)
- [OpenAI Whisper](https://github.com/openai/whisper) (MIT): large-v3 and large-v3-turbo
- [distil-whisper](https://github.com/huggingface/distil-whisper) (MIT): distil-large-v3.5
- [Silero VAD](https://github.com/snakers4/silero-vad) (MIT)

Each model keeps its own license. Check it before you use the model for anything beyond local
testing.

## License

Apache-2.0. See [LICENSE](LICENSE).
