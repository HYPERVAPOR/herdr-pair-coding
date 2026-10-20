#!/usr/bin/env bash
# Rebuild the demo copy of herdr-watchdog.
#
# Differences from the shipped tool (message text, pairing and judgement are
# untouched):
#   STALE_SEC = 3      instead of 600  -> a quiet pair is "stuck" after 3s
#   INTERVAL  = 3      instead of 20   -> one pass every 3s
#   dry passes also write the last-pass snapshot, so `top` can stay live
#   without sending anything (feeder.py relies on this)
#
# usage: make-demo-tool.sh [source-tool] [output-path]
set -euo pipefail

src=${1:-$(readlink -f "$HOME/.local/bin/herdr-watchdog")}
out=${2:-/tmp/gifdemo/herdr-watchdog-demo}
mkdir -p "$(dirname "$out")"
cp "$src" "$out"
sed -i 's/^STALE_SEC = 600/STALE_SEC = 3/; s/^INTERVAL = 20/INTERVAL = 3/' "$out"

python3 - "$out" <<'PY'
import sys

path = sys.argv[1]
src = open(path).read()
old = """    if not DRY:
        write_snapshot(sessions, seen, now, time.time() - now)   # mirror for the top view; dry-run does not write"""
new = """    # DEMO PATCH: also mirror on a dry pass, so a recording can keep the top
    # view live without sending anything.
    write_snapshot(sessions, seen, now, time.time() - now)"""
if old not in src:
    sys.exit("snapshot write site not found -- herdr-watchdog changed, review this patch")
open(path, "w").write(src.replace(old, new, 1))
PY
chmod +x "$out"
grep -n '^STALE_SEC\|^INTERVAL' "$out"
echo "demo tool: $out"
