#!/usr/bin/env bash
# whisper-lab installer: builds whisper.cpp's whisper-server, downloads the chosen models (plus
# Silero VAD) from Hugging Face with sha256 checks, and sets up transcribe.cpp for Parakeet.
# Everything goes to the state dir: $WHISPER_LAB_HOME, else $XDG_CACHE_HOME/whisper-lab, else
# ~/.cache/whisper-lab. Safe to re-run: finished steps are skipped, files already present are
# re-verified, and interrupted downloads resume.
#
#   ./install.sh [--models all|id,id,...] [--rebuild]
#
# Env: WHISPER_LAB_BACKEND=vulkan|cuda|metal|cpu forces the whisper.cpp backend (default: detect).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODELS_ARG=all
REBUILD=0

usage() {
  cat <<EOF
usage: $0 [--models all|id,id,...] [--rebuild]

  --models   which models to install (default: all). Ids:
             turbo-q5_0, parakeet-v2, turbo-q8_0, large-v3-q5_0, distil-large-v3.5, turbo-f16
  --rebuild  rebuild whisper-server even if it is already built

  WHISPER_LAB_HOME      state dir (default: \$XDG_CACHE_HOME/whisper-lab or ~/.cache/whisper-lab)
  WHISPER_LAB_BACKEND   vulkan | cuda | metal | cpu (default: detected)
EOF
}

while (($#)); do
  case $1 in
    --models) MODELS_ARG=${2:?--models needs a value}; shift 2 ;;
    --models=*) MODELS_ARG=${1#*=}; shift ;;
    --rebuild) REBUILD=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have node || die "Node.js 20 or newer is required (it runs the lab and reads models.json)"
catalog() { node "$HERE/lib/catalog.mjs" "$@"; }
pin() { catalog pin "$1"; }

STATE="$(catalog state)"
MODELS="$STATE/models"
DOWNLOADS="$STATE/downloads"
BIN="$STATE/bin"
mkdir -p "$MODELS" "$DOWNLOADS" "$BIN"

for tool in curl tar; do have "$tool" || die "$tool is required"; done
if have sha256sum; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif have shasum; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "sha256sum or shasum is required"
fi
filesize() { wc -c <"$1" | tr -d ' '; }
mb() { awk -v b="$1" 'BEGIN { printf "%.0f MB", b / 1e6 }'; }
cpus() { getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4; }

# fetch <url> <dest> <bytes or ""> <sha256>: download with resume, verify size and sha256, then
# move into place. A file already at <dest> is re-verified; a bad one is downloaded again.
fetch() {
  local url=$1 dest=$2 bytes=$3 want=$4 part="$2.part" got
  if [[ -f $dest ]]; then
    printf '  %s: present, checking sha256... ' "$(basename "$dest")"
    got=$(sha256 "$dest")
    if [[ $got == "$want" ]]; then echo "ok"; return 0; fi
    echo "MISMATCH (got $got), downloading again"
    rm -f "$dest"
  fi
  if [[ -f $part && -n $bytes && $(filesize "$part") -gt $bytes ]]; then rm -f "$part"; fi
  echo "  downloading $url"
  local progress=(-sS)
  [[ ! -t 2 ]] || progress=(--progress-bar)
  if ! curl -fL "${progress[@]}" --retry 3 --retry-delay 2 -C - -o "$part" "$url"; then
    # A server that ignores ranges makes curl refuse to resume: start over once.
    rm -f "$part"
    curl -fL "${progress[@]}" --retry 3 --retry-delay 2 -o "$part" "$url" || die "download failed: $url"
  fi
  got=$(filesize "$part")
  if [[ -n $bytes && $got != "$bytes" ]]; then
    rm -f "$part"
    die "$(basename "$dest"): expected $bytes bytes, got $got; run again to retry"
  fi
  printf '  %s: checking sha256... ' "$(basename "$dest")"
  got=$(sha256 "$part")
  if [[ $got != "$want" ]]; then
    rm -f "$part"
    echo "MISMATCH"
    die "$(basename "$dest"): sha256 is $got, expected $want"
  fi
  echo "ok"
  mv "$part" "$dest"
}

# ---- what to install -----------------------------------------------------------------------

SELECTED="$(catalog select "$MODELS_ARG")" || exit 2

CC_BIN=""
for c in cc gcc clang; do if have "$c"; then CC_BIN=$c; break; fi; done
PARAKEET_SKIP=""
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  PARAKEET_SKIP="transcribe.cpp ships a prebuilt library for Linux x86_64 only (this is $(uname -s) $(uname -m))"
elif [[ -z $CC_BIN ]]; then
  PARAKEET_SKIP="no C compiler found (cc, gcc or clang); install one (e.g. gcc) and run install.sh again"
fi

WANT=()        # "id<TAB>engine<TAB>file<TAB>bytes<TAB>sha256<TAB>url<TAB>label" lines
NEED_WHISPER=0
NEED_PARAKEET=0
while IFS= read -r line; do
  [[ -n $line ]] || continue
  IFS=$'\t' read -r id engine _rest <<<"$line"
  if [[ $engine == transcribe ]]; then
    if [[ -n $PARAKEET_SKIP ]]; then
      echo "Skipping $id: $PARAKEET_SKIP."
      continue
    fi
    NEED_PARAKEET=1
  else
    NEED_WHISPER=1
  fi
  WANT+=("$line")
done <<<"$SELECTED"
((${#WANT[@]})) || die "nothing to install"

echo "State dir: $STATE"
echo "Disk needed (downloads; files already present are only re-verified):"
total=0
for line in "${WANT[@]}"; do
  IFS=$'\t' read -r id _engine file bytes _sha _url label <<<"$line"
  printf '  %-18s %8s  %s\n' "$id" "$(mb "$bytes")" "$label"
  total=$((total + bytes))
done
if ((NEED_WHISPER)); then
  vb=$(pin vad.bytes)
  printf '  %-18s %8s  %s\n' "silero-vad" "$(mb "$vb")" "voice activity model for whisper-server"
  printf '  %-18s %8s  %s\n' "whisper.cpp" "~500 MB" "source and build tree while building (the build tree is deleted after)"
  total=$((total + vb))
fi
if ((NEED_PARAKEET)); then
  printf '  %-18s %8s  %s\n' "transcribe.cpp" "~90 MB" "prebuilt library for Parakeet (download plus unpacked)"
fi
echo "  total models: $(mb "$total")"
echo

# ---- whisper.cpp ---------------------------------------------------------------------------

detect_backend() {
  if [[ -n ${WHISPER_LAB_BACKEND:-} ]]; then echo "$WHISPER_LAB_BACKEND"; return; fi
  if [[ "$(uname -s)" == Darwin ]]; then echo metal; return; fi
  if have nvcc || [[ -x /usr/local/cuda/bin/nvcc ]]; then echo cuda; return; fi
  if have glslc; then
    if { have pkg-config && pkg-config --exists vulkan; } ||
      [[ -f /usr/include/vulkan/vulkan.h || -f /usr/local/include/vulkan/vulkan.h ||
        (-n ${VULKAN_SDK:-} && -f ${VULKAN_SDK:-}/include/vulkan/vulkan.h) ]]; then
      echo vulkan
      return
    fi
  fi
  echo cpu
}

build_whisper() {
  local backend src_dir tarball build flags built
  backend=$(detect_backend)
  case $backend in vulkan | cuda | metal | cpu) ;; *) die "WHISPER_LAB_BACKEND must be vulkan, cuda, metal or cpu" ;; esac
  if ((!REBUILD)) && [[ -x $BIN/whisper-server && "$(cat "$BIN/backend" 2>/dev/null)" == "$backend" ]]; then
    echo "whisper-server: already built ($backend)"
    return
  fi
  have cmake || die "cmake is required to build whisper.cpp"
  have c++ || have g++ || have clang++ || die "a C++ compiler (g++ or clang++) is required to build whisper.cpp"
  [[ $backend != cuda ]] || have nvcc || export PATH="/usr/local/cuda/bin:$PATH"

  echo "whisper.cpp $(pin whisper.tag): building whisper-server for $backend"
  tarball="$DOWNLOADS/$(pin whisper.dir).tar.gz"
  fetch "$(pin whisper.url)" "$tarball" "" "$(pin whisper.sha256)"
  src_dir="$STATE/src/$(pin whisper.dir)"
  if [[ ! -f $src_dir/CMakeLists.txt ]]; then
    mkdir -p "$STATE/src"
    rm -rf "$src_dir"
    tar -xzf "$tarball" -C "$STATE/src"
    [[ -f $src_dir/CMakeLists.txt ]] || die "the whisper.cpp tarball didn't hold $(pin whisper.dir)"
  fi

  build="$STATE/build-$backend"
  flags=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON)
  case $backend in
    vulkan) flags+=(-DGGML_VULKAN=ON) ;;
    cuda) flags+=(-DGGML_CUDA=ON) ;;
    metal) flags+=(-DGGML_METAL=ON) ;;
    cpu) [[ "$(uname -s)" != Darwin ]] || flags+=(-DGGML_METAL=OFF) ;;
  esac
  echo "  cmake ${flags[*]}"
  cmake -S "$src_dir" -B "$build" "${flags[@]}" >"$STATE/build.log" 2>&1 ||
    { tail -n 30 "$STATE/build.log" >&2; die "cmake configure failed (full log: $STATE/build.log)"; }
  cmake --build "$build" --config Release -j "$(cpus)" --target whisper-server >>"$STATE/build.log" 2>&1 ||
    { tail -n 30 "$STATE/build.log" >&2; die "whisper.cpp build failed (full log: $STATE/build.log)"; }
  built=""
  for f in "$build/bin/whisper-server" "$build/bin/Release/whisper-server"; do [[ -x $f ]] && built=$f && break; done
  [[ -n $built ]] || die "the build finished without a whisper-server binary (log: $STATE/build.log)"
  cp "$built" "$BIN/whisper-server.tmp"
  chmod 755 "$BIN/whisper-server.tmp"
  mv "$BIN/whisper-server.tmp" "$BIN/whisper-server"
  echo "$backend" >"$BIN/backend"
  rm -rf "$build"
  echo "  built $BIN/whisper-server"
}

# ---- transcribe.cpp (Parakeet) -------------------------------------------------------------

build_parakeet_host() {
  local dir="$STATE/transcribe-$(pin transcribe.tag)" tarball tmp
  if [[ -x $dir/transcribe-host ]]; then
    echo "transcribe-host: already built"
    return
  fi
  echo "transcribe.cpp $(pin transcribe.tag): setting up the Parakeet host"
  tarball="$DOWNLOADS/transcribe-$(pin transcribe.tag)-$(pin transcribe.platform).tar.gz"
  fetch "$(pin transcribe.url)" "$tarball" "$(pin transcribe.bytes)" "$(pin transcribe.sha256)"
  tmp="$STATE/.extract-$$"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  tar -xzf "$tarball" -C "$tmp"
  [[ -d $tmp/$(pin transcribe.dir) ]] || die "the transcribe.cpp archive didn't hold $(pin transcribe.dir)"
  rm -rf "$dir"
  mv "$tmp/$(pin transcribe.dir)" "$dir"
  rm -rf "$tmp"
  fetch "$(pin transcribe.headerUrl)" "$dir/transcribe.h" "$(pin transcribe.headerBytes)" "$(pin transcribe.headerSha256)"
  echo "  compiling transcribe-host with $CC_BIN"
  # shellcheck disable=SC2016 # $ORIGIN is for the linker, not the shell
  "$CC_BIN" -O2 -std=gnu11 -o "$dir/transcribe-host.tmp" "$HERE/native/transcribe-host.c" \
    "-I$dir" "-L$dir" -ltranscribe '-Wl,-rpath,$ORIGIN' || die "compiling transcribe-host failed"
  chmod 755 "$dir/transcribe-host.tmp"
  mv "$dir/transcribe-host.tmp" "$dir/transcribe-host"
  echo "  built $dir/transcribe-host"
}

# ---- run -----------------------------------------------------------------------------------

if ((NEED_WHISPER)); then
  build_whisper
  echo "silero-vad:"
  fetch "$(pin vad.url)" "$MODELS/$(pin vad.file)" "$(pin vad.bytes)" "$(pin vad.sha256)"
fi
if ((NEED_PARAKEET)); then build_parakeet_host; fi

for line in "${WANT[@]}"; do
  IFS=$'\t' read -r id _engine file bytes sha url _label <<<"$line"
  echo "$id:"
  fetch "$url" "$MODELS/$file" "$bytes" "$sha"
done

echo
echo "Installed:"
catalog installed | while IFS=$'\t' read -r id port _engine _file; do echo "  $id (port $port)"; done
if [[ -n $PARAKEET_SKIP ]] && [[ $SELECTED == *$'\ttranscribe\t'* ]]; then
  echo "Parakeet was skipped: $PARAKEET_SKIP."
fi
echo "Next: ./lab.sh start, then open http://127.0.0.1:$(catalog lab-port)/"
