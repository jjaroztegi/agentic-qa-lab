# Shared by the pipeline scripts: isolated env, screen recording, events for the control room.
# Every step works the same from GitHub Actions, Azure DevOps or a laptop.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
emit() { [[ -n ${QA_EVENTS_URL:-} && -f $ROOT/tools/emit.mjs ]] && node "$ROOT/tools/emit.mjs" "$@" || true; }
stage() { emit stage "$RUN_ID" "$@"; }

env_up() {
  local kv out
  trap env_down EXIT
  out=$("$ROOT/tools/e2e-env.sh" up "$RUN_ID") || { echo "Could not create the isolated environment" >&2; exit 1; }
  while IFS= read -r kv; do
    export "${kv%%=*}=${kv#*=}"
    if [[ -n ${GITHUB_ENV:-} ]]; then echo "$kv" >> "$GITHUB_ENV"; fi
  done <<< "$out"
}
# On exit: recording uploaded, environment gone, and the run's verdict for the control room
# (RESULT_TITLE, set by the script, says it in business words).
env_down() {
  local rc=$?
  rec_stop; "$ROOT/tools/e2e-env.sh" down "$RUN_ID" || true
  emit event "$(jq -nc --arg r "$RUN_ID" --arg s "$( ((rc == 0)) && echo ok || echo fail)" --arg t "${RESULT_TITLE:-}" \
    '{run:$r, source:"ci", kind:"result", status:$s, title:(if $t == "" then null else $t end)}')"
  return $rc
}

# The whole screen of the run's desktop (browser with QA_SHOW=1 + Java client), start to end.
rec_start() {
  read -ra EXEC <<< "$DESKTOP_EXEC"
  "${EXEC[@]}" bash -lc 'source ~/.desktop-env; exec ffmpeg -loglevel error -y -f x11grab -framerate 15 -video_size 1920x1080 -i $DISPLAY -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov /tmp/screen.mp4' &
  REC_PID=$!
  emit run "$RUN_ID" "{\"recording_started_at\":\"$(node -p "new Date().toISOString()")\"}"
}
rec_stop() {
  [[ -n ${REC_PID:-} ]] || return 0
  read -ra EXEC <<< "$DESKTOP_EXEC"
  "${EXEC[@]}" pkill -INT -f 'ffmpeg.*screen.mp4' || true
  wait "$REC_PID" 2>/dev/null || true; REC_PID=
  mkdir -p "$ROOT/evidence"
  "${EXEC[@]}" cat /tmp/screen.mp4 > "$ROOT/evidence/screen.mp4" && emit file "$RUN_ID" "$ROOT/evidence/screen.mp4" screen.mp4
}
