#!/usr/bin/env bash
# Build the demo HOME that the panes run pi in.
#
# Why: the pi profiles point at $HOME/.pi/agent/profiles/<role>.md. With the
# real HOME that is the user's own (here: Chinese) role prompt, so the demo
# would answer in Chinese. This builds a throwaway HOME that shares auth,
# extensions, packages and settings with the real one, but ships the English
# example role prompts from the herdr-pair-coding repo.
#
# usage: make-demo-home.sh [demo-home]
set -euo pipefail

DEMO=${1:-/tmp/gifdemo/home}
AGENT=$DEMO/.pi/agent
PKG=${HERDR_PAIR:-$HOME/.pi/agent/git/github.com/HYPERVAPOR/herdr-pair-coding}

rm -rf "$DEMO"
mkdir -p "$AGENT/profiles" "$AGENT/sessions"

# share everything that does not decide the prompt
for e in auth.json models.json models-store.json bin extensions git install npm themes; do
	[ -e "$HOME/.pi/agent/$e" ] && ln -s "$HOME/.pi/agent/$e" "$AGENT/$e"
done
cp "$HOME/.pi/agent/settings.json" "$AGENT/settings.json"
[ -f "$HOME/.pi/agent/trust.json" ] && cp "$HOME/.pi/agent/trust.json" "$AGENT/trust.json"

# the user's role confs (tools, extensions), unchanged: they resolve their
# prompts through $HOME, which now points here
cp "$HOME/.pi/agent/profiles/worker.conf" "$AGENT/profiles/worker.conf"
cp "$HOME/.pi/agent/profiles/reviewer.conf" "$AGENT/profiles/reviewer.conf"
[ -f "$HOME/.pi/agent/profiles/labels.conf" ] && cp "$HOME/.pi/agent/profiles/labels.conf" "$AGENT/profiles/labels.conf"

# English role prompts
cp "$PKG/examples/profiles/worker.md.example" "$AGENT/profiles/worker.md"
cp "$PKG/examples/profiles/reviewer.md.example" "$AGENT/profiles/reviewer.md"

# catppuccin mocha for the pi TUI as well, not just herdr
python3 - "$AGENT/settings.json" <<'PY'
import json
import sys

path = sys.argv[1]
cfg = json.load(open(path))
cfg["theme"] = "catppuccin-mocha"
json.dump(cfg, open(path, "w"), indent=2)
print("pi theme:", cfg["theme"])
PY

# a shell that starts without the zsh new-user wizard
cat >"$DEMO/.zshrc" <<'EOF'
setopt no_beep
PROMPT='%F{blue}%~%f %# '
EOF
cat >"$DEMO/.bashrc" <<'EOF'
PS1='\w \$ '
EOF

echo "demo home: $DEMO"
