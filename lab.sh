#!/usr/bin/env bash
# whisper-lab: start|stop|restart|status the lab page (127.0.0.1:8850 by default) and one speech
# server per installed model (8851 and up, one port per catalog entry). Ports come from
# config.json, or $WHISPER_LAB_PORT / $WHISPER_LAB_MODEL_PORT (the first model port). Pids and
# logs live in <state dir>/run. Run ./install.sh first.
#
# Env: WHISPER_LAB_NO_GPU=1 runs every model on the CPU; WHISPER_LAB_THREADS sets threads per model.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "error: Node.js 20 or newer is required" >&2; exit 1; }
catalog() { node "$HERE/lib/catalog.mjs" "$@"; }

STATE="$(catalog state)"
RUN="$STATE/run"
MODELS="$STATE/models"
WHISPER="$STATE/bin/whisper-server"
HOST="$STATE/transcribe-$(catalog pin transcribe.tag)/transcribe-host"
VAD="$MODELS/$(catalog pin vad.file)"
LAB_PORT="$(catalog lab-port)"
THREADS="$(catalog threads)"
mkdir -p "$RUN"

alive() { [[ -f $1 ]] && kill -0 "$(cat "$1")" 2>/dev/null; }
stop_pid() { # stop_pid <pidfile> <name>
  if alive "$1"; then kill "$(cat "$1")" && echo "stopped $2"; fi
  rm -f "$1"
}
up() { curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$1/health"; }

start_models() {
  local id port engine file pidf cmd
  while IFS=$'\t' read -r id port engine file; do
    pidf="$RUN/$id.pid"
    if alive "$pidf"; then echo "$id already running on $port (pid $(cat "$pidf"))"; continue; fi
    if [[ $engine == transcribe ]]; then
      cmd=("$HOST" --host 127.0.0.1 --port "$port" -m "$MODELS/$file" -t "$THREADS" --inference-path /inference)
    else
      cmd=("$WHISPER" --host 127.0.0.1 --port "$port" -m "$MODELS/$file" -t "$THREADS" --inference-path /inference)
      [[ ! -f $VAD ]] || cmd+=(-vm "$VAD")
    fi
    [[ -z ${WHISPER_LAB_NO_GPU:-} ]] || cmd+=(--no-gpu)
    nohup "${cmd[@]}" >"$RUN/$id.log" 2>&1 &
    echo $! >"$pidf"
    echo "started $id on 127.0.0.1:$port (pid $!), log $RUN/$id.log"
  done < <(catalog installed)
}

case "${1:-status}" in
  start)
    if [[ -z "$(catalog installed)" ]]; then
      echo "No models installed in $STATE; run ./install.sh first." >&2
      exit 1
    fi
    if alive "$RUN/server.pid"; then echo "lab already running (pid $(cat "$RUN/server.pid"))"; else
      nohup node "$HERE/server.mjs" >>"$RUN/server.log" 2>&1 &
      echo $! >"$RUN/server.pid"
      echo "lab started on http://127.0.0.1:$LAB_PORT/ (pid $!), log $RUN/server.log"
    fi
    start_models
    echo "Models take a few seconds to load; ./lab.sh status shows when they're up." ;;
  stop)
    stop_pid "$RUN/server.pid" "lab"
    while IFS=$'\t' read -r id port _engine _file; do stop_pid "$RUN/$id.pid" "$id ($port)"; done < <(catalog all) ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status)
    if alive "$RUN/server.pid"; then echo "lab $LAB_PORT: running (pid $(cat "$RUN/server.pid"))"; else echo "lab $LAB_PORT: stopped"; fi
    while IFS=$'\t' read -r id port _engine _file; do
      if up "$port"; then echo "$id $port: up"
      elif alive "$RUN/$id.pid"; then echo "$id $port: loading (or failed; see $RUN/$id.log)"
      else echo "$id $port: down"; fi
    done < <(catalog installed) ;;
  *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
