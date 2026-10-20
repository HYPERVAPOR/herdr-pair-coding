#!/usr/bin/env bash
# Demo choreography for herdr-pair-coding.
#
# Visible tab:  worker | reviewer
#               worker | watchdog top (bottom-right)
# Two more pairs sit idle in their own tabs so the watchdog's telemetry view has
# a pair tree to draw.
#
# The herdr TUI runs in the foreground; a background child drives everything
# with the same commands the skill tells an agent to use. The system watchdog
# daemon is paused for the take and replaced by
#   * feeder.py        - dry passes every 3 s, so `top` has a live mirror
#   * a real pass      - with --tab, at the moment pair 1 goes quiet
set -uo pipefail

S=/tmp/gifdemo
SOCK=${SOCK:-$HOME/.config/herdr/sessions/gifdemo/herdr.sock}
SESSION=${SESSION:-gifdemo}
WORK=${WORK:-/tmp/gifdemo/work}
THEME_CONF=${THEME_CONF:-$S/theme.toml}
LOG=$S/driver.log
END=$S/END
HB=$S/hb
DEMO_HOME=$S/home      # pi runs with an English profile set from here
rm -f "$END" "$S/refresh" "$S/tabs.txt"
: >"$LOG"

unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_BIN_PATH TERM_PROGRAM
export HERDR_SOCKET_PATH=$SOCK
export HERDR_SESSION=$SESSION
export HB_DIR=$HB

log() { printf '%s %s\n' "$(date +%T.%2N)" "$*" >>"$LOG"; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval("d"+sys.argv[1]))' "$1"; }

TASK='Implement mathkit.clamp(value, lo, hi) in this repo so that `python3 -m unittest discover -s tests -q` passes. Keep the diff small: one function, no new files. Then answer in three short lines: what changed, what you ran, what is still open.'
REVIEW='Review the clamp change the worker just made. Start by calling hb_block with action=unblock and reason="starting review" - the footer should read hb_block:false and the watchdog should stay listening while you work. Then read the worker answer with herdr-last-answer, check the diff in the worktree, run the test suite yourself, and reply in three short lines: verdict, evidence, next step. Leave the heartbeat unblocked when you finish.'

wait_answer() {
	local pane=$1 base out st seq i
	base=$(herdr agent get "$pane" 2>/dev/null | jget "['result']['agent']['state_change_seq']")
	base=${base:-0}
	for i in $(seq 1 1200); do
		sleep 0.5
		out=$(herdr agent get "$pane" 2>/dev/null) || continue
		st=$(printf %s "$out" | jget "['result']['agent']['agent_status']")
		seq=$(printf %s "$out" | jget "['result']['agent']['state_change_seq']")
		if [ "${seq:-0}" -gt "$base" ] && { [ "$st" = idle ] || [ "$st" = done ]; }; then
			log "  $pane -> $st (seq $base->$seq)"
			return 0
		fi
	done
	log "  $pane TIMEOUT"
	return 1
}

pause_wd() { mkdir -p "$HOME/.herdr/watchdog"; : >"$HOME/.herdr/watchdog/PAUSE"; }
resume_wd() { rm -f "$HOME/.herdr/watchdog/PAUSE"; }

choreo() {
	sleep 2.5

	# --- visible tab: worker | reviewer over watchdog -----------------------
	OLD=$(herdr tab list | jget "['result']['tabs'][0]['tab_id']")
	NEW=$(herdr tab create --cwd "$WORK" --label pair --env "HOME=$DEMO_HOME" --env COLORTERM=truecolor --env "HB_DIR=$HB")
	T1=$(printf %s "$NEW" | jget "['result']['tab']['tab_id']")
	P=$(printf %s "$NEW" | jget "['result']['root_pane']['pane_id']")
	herdr tab close "$OLD" >/dev/null 2>&1
	R=$(herdr pane split --pane "$P" --direction right --ratio 0.45 --env "HOME=$DEMO_HOME" --env COLORTERM=truecolor --env "HB_DIR=$HB" | jget "['result']['pane']['pane_id']")
	# the watchdog pane keeps the real HOME: herdr-watchdog resolves its session
	# through ~/.config/herdr, and HB_DIR is pointed at the demo snapshot.
	D=$(herdr pane split --pane "$R" --direction down --ratio 0.62 | jget "['result']['pane']['pane_id']")
	herdr pane rename "$P" worker >/dev/null
	herdr pane rename "$R" reviewer >/dev/null
	herdr pane rename "$D" watchdog >/dev/null
	log "pair: $P $R watchdog=$D"
	sleep 0.5

	# --- two more pairs, idle, in their own tabs ---------------------------
	OTHERS=""
	for name in api docs; do
		NEW=$(herdr tab create --cwd "$WORK" --label "pair-$name" --env "HOME=$DEMO_HOME" --env COLORTERM=truecolor --env "HB_DIR=$HB")
		A=$(printf %s "$NEW" | jget "['result']['root_pane']['pane_id']")
		B=$(herdr pane split --pane "$A" --direction right --ratio 0.5 --env "HOME=$DEMO_HOME" --env COLORTERM=truecolor --env "HB_DIR=$HB" | jget "['result']['pane']['pane_id']")
		herdr pane rename "$A" worker >/dev/null
		herdr pane rename "$B" reviewer >/dev/null
		OTHERS="$OTHERS $A $B"
		log "tab pair-$name: $A $B"
		sleep 0.4
	done
	herdr tab focus "$T1" >/dev/null
	sleep 0.8

	# --- state left by the previous round ----------------------------------
	# The reviewer blocked the pair when it finished, so the footer starts at
	# hb_block:true and the prompt's unblock is a real true -> false transition.
	HB_DIR=$HB HERDR_SESSION=$SESSION HERDR_TAB_ID=$T1 HERDR_PANE_ID=$R \
		"$S/herdr-watchdog-demo" set --action=block --by "$R" \
		--reason="round finished; waiting for the next task" >/dev/null 2>&1

	# --- profiles ----------------------------------------------------------
	herdr pane run "$P" pi-profile >/dev/null
	herdr pane run "$R" pi-profile >/dev/null
	for p in $OTHERS; do herdr pane run "$p" pi-profile >/dev/null; done
	log "profiles started"
	sleep 1.0
	herdr pane run "$D" "HB_DIR=$HB python3 $S/feeder.py >/dev/null 2>&1 & HB_DIR=$HB herdr-watchdog top" >/dev/null
	log "watchdog top up"
	sleep 7

	# --- the round ---------------------------------------------------------
	herdr agent wait "$P" --until idle --timeout 30000 >/dev/null 2>&1
	log "prompt worker"
	herdr agent prompt "$P" "$TASK" >/dev/null 2>&1
	wait_answer "$P"
	sleep 4
	touch "$S/refresh"
	log "prompt reviewer"
	herdr agent wait "$R" --until idle --timeout 30000 >/dev/null 2>&1
	herdr agent prompt "$R" "$REVIEW" >/dev/null 2>&1
	wait_answer "$R"
	touch "$S/refresh"
	sleep 12
	log "end"
	: >"$END"
}

git -C "$WORK" reset --hard -q "$(git -C "$WORK" rev-list --max-parents=0 HEAD)"
git -C "$WORK" clean -fdq
rm -rf "$HB"
mkdir -p "$HB"

pause_wd
choreo &
CH=$!

cd "$WORK" || exit 1
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
	-u HERDR_SOCKET_PATH -u TERM_PROGRAM -u HERDR_BIN_PATH -u HERDR_SESSION -u HB_DIR \
	HERDR_CONFIG_PATH="$THEME_CONF" \
	herdr --session "$SESSION"

kill "$CH" 2>/dev/null
wait "$CH" 2>/dev/null
resume_wd
: >"$END"
log "tui exited"
