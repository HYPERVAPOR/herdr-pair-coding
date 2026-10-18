#!/usr/bin/env bash
# Real-machine evidence for stage 3 ("really send / really interrupt"). Run by hand; not part
# of selftest.
#   Creates its own temporary tab + two temporary panes (reviewer/worker), has the reviewer run
#   a command that never returns, ages its session file by 15 minutes, runs
#   `herdr-watchdog run --tab <temp tab>`, then closes the temp tab.
#   Only touches panes it created; never messages or interrupts another pair or a human's pane.
#   To tell whether esc worked, look for `Command aborted` (toolResult with a small durationMs)
#   in the session file. Do NOT look at "is there still a process with the same name": an
#   interrupted agent may run the same command again after receiving the message, which looks
#   like it was not killed (a real trap during review).
# Run: bash test/interrupt-evidence.sh

# Stage 3: evidence of a real interrupt (only temp panes this script creates; the reviewer gets
# a conditional system prompt so it does not wander off).
set -e
# Locate herdr-watchdog relative to this script (no hardcoded worktree/home path).
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD="$(dirname "$SELF_DIR")"
cd ~
SYS="You are a test agent. By default reply with a single word and do not call any tool; only when a message explicitly tells you to run a shell command, use the bash tool to run it."

read TABID PA PB < <(herdr tab create --workspace wE --cwd /tmp --label hbint | python3 -c "
import json,sys; d=json.load(sys.stdin)['result']; print(d['tab']['tab_id'], d['root_pane']['pane_id'])")
PB=$(herdr pane split --pane $PA --direction down --cwd /tmp --no-focus | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['pane']['pane_id'])")
herdr pane rename $PA reviewer >/dev/null
herdr pane rename $PB worker >/dev/null
echo "temp tab=$TABID reviewer=$PA worker=$PB"

RSES=$(herdr agent start hbrev3 --kind pi --pane $PA -- --append-system-prompt "$SYS" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['agent']['agent_session']['value'])")
herdr agent start hbwrk3 --kind pi --pane $PB >/dev/null
echo "reviewer session file: $RSES"

echo "--- make the reviewer run a command that never returns"
herdr agent prompt hbrev3 "Use the bash tool to run this command: sleep 9999. Pass null for timeout." --wait --until working --timeout 30000 >/dev/null
for i in $(seq 1 20); do sleep 2; ps -C sleep -o pid= 2>/dev/null | grep -q . && break; done
echo "--- sleep process before interrupt (parent is that pane's pi):"
ps -o pid,ppid,etime,cmd -C sleep
SP=$(ps -C sleep -o pid= | tr -d ' ' | head -1)
echo "    parent cmd of sleep $SP: $(ps -o cmd= -p $(ps -o ppid= -p $SP | tr -d ' '))"
touch -d '15 minutes ago' "$RSES"
echo "--- reviewer: session file age $(( ($(date +%s) - $(stat -c %Y "$RSES")) / 60 )) minutes; status $(herdr agent get hbrev3 | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["agent"]["agent_status"])')"

echo "--- run the watchdog for real (judge $TABID only)"
cd "$WD"
HB_DIR=/tmp/hb-probe-state python3 herdr-watchdog run --tab "$TABID" 2>&1 | grep -v "^2026.*WARN  mysession/wE:t4"
sleep 2
echo "--- sleep processes after interrupt:"
ps -o pid,ppid,etime,cmd -C sleep || echo "   (none - the reviewer's sleep was killed)"
echo "--- traces in the reviewer session file:"
python3 - "$RSES" <<'EOF'
import json,sys
A = "Your command produced no output"
B = "Neither you nor the worker is working"
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except Exception: continue
    m=d.get("message") or {}
    s=json.dumps(m, ensure_ascii=False)
    if m.get("role")=="toolResult" and "aborted" in s.lower():
        print("  [aborted toolResult]", s[:150])
    if m.get("role")=="user":
        if A in s: print("  [user message] message A delivered ->", A)
        elif B in s: print("  [user message] message B delivered")
EOF
echo "--- close the temp tab"
herdr tab close "$TABID" >/dev/null
sleep 2
ps -o pid,cmd -C sleep || echo "  (all sleep processes gone)"
herdr agent list | python3 -c "
import json,sys; d=json.load(sys.stdin)['result']['agents']
print('leftover temp agents:', [a['pane_id'] for a in d if (a.get('name') or '').startswith('hbrev') or (a.get('name') or '').startswith('hbwrk')])
print('agents:', [a['pane_id'] for a in d])"
echo "--- flag files left by this run (should be none: nobody called hb_block):"; ls ~/.herdr/hb/ 2>/dev/null
