---
name: herdr-pair-coding
description: "Set up or operate herdr-pair-coding: worker-reviewer pair coding on top of herdr."
---

# herdr-pair-coding setup

Goal: two panes, `worker` and `reviewer`, each running an agent, plus a
watchdog that nudges the pair when it stalls.

The three tools are plain CLIs and only need herdr. pi turns
the CLIs into model-facing tools and adds role profiles.

## 1. Preflight

Required:

```bash
herdr --version
python3 --version
git --version        # only for refs-reclaim
```

## 2. Install and wire herdr

```bash
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi     # or claude, codex, ... ; `herdr integration` lists them
```

The integration writes the agent's own state hook; herdr owns that file, do not
edit it.

herdr has to be running (`herdr`) and the agents have to live in its panes.
Outside herdr, `HERDR_ENV` is not `1` and the tools have nothing to talk to.

Starting `herdr` itself needs an interactive terminal. Your shell tool has no
TTY, so ask the user to run `herdr` and start the pi panes. Once the server is
up, `herdr pane ...` control commands work without a TTY.

## 3. Get the tools

With pi:

```bash
pi install git:github.com/HYPERVAPOR/herdr-pair-coding
P="$HOME/.pi/agent/git/github.com/HYPERVAPOR/herdr-pair-coding"
```

Without pi:

```bash
git clone https://github.com/HYPERVAPOR/herdr-pair-coding "$HOME/herdr-pair-coding"
P="$HOME/herdr-pair-coding"
```

Put the CLIs on `PATH` either way:

```bash
mkdir -p ~/.local/bin
ln -sfn "$P/herdr-watchdog/herdr-watchdog"       ~/.local/bin/herdr-watchdog
ln -sfn "$P/herdr-last-answer/herdr-last-answer" ~/.local/bin/herdr-last-answer
ln -sfn "$P/refs-reclaim/refs-reclaim"           ~/.local/bin/refs-reclaim
```

At this point the workflow already works without pi: label the panes, start the
agents, run the watchdog. The next two sections are the pi integration.

## 4. Profiles (pi only)

Copy the two role files and their rule examples into place:

```bash
mkdir -p ~/.pi/agent/profiles
cp "$P"/examples/profiles/*.conf "$P"/examples/profiles/*.md.example ~/.pi/agent/profiles/
```

Each `.conf` sets a `PROFILE` array; a small shell function runs it:

```bash
pi-profile() {
  local f="$HOME/.pi/agent/profiles/$1.conf"
  [ -r "$f" ] || { echo "no such profile: $f" >&2; return 1; }
  source "$f"
  command pi -ne -ns -np --no-mcp $PROFILE "${@:2}"
}
```

- `-ne` no discovered extensions, `-ns` no skills, `-np` no prompt templates,
  `--no-mcp` no MCP servers: the profile mounts exactly what it lists.
- `--tools` is a whitelist. A tool missing there is invisible to the model.
- `--append-system-prompt` takes a path or literal text. A missing file is
  appended as the literal path, not an error, so check that each path exists.

The worker gets `read,write,edit,ls,bash`. The reviewer additionally gets
`last_answer` and `hb_block`, and mounts their two extension files.

If the user does not use pi, skip this section and tell the agents what to
call: `herdr-last-answer <worker>` for the answer text, and
`herdr-watchdog set --action block --reason "..."` to silence the watchdog.

## 5. Label the panes

The watchdog finds pairs by label, not by layout:

```bash
herdr pane rename <worker_pane_id> worker
herdr pane rename <reviewer_pane_id> reviewer
```

The labels only need to contain the words `worker` and `reviewer`, so
`api-worker` / `api-reviewer` also match.

## 6. Watchdog

```bash
herdr-watchdog daemon
```

As a systemd user service:

```ini
[Unit]
Description=herdr-watchdog
After=default.target

[Service]
Type=simple
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 %h/.local/bin/herdr-watchdog daemon
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now herdr-watchdog
herdr-watchdog top        # read-only live view
```

The daemon only reads pane state and sends messages. `~/.herdr/watchdog/PAUSE`
pauses it.

## 7. Verify

CLI checks:

1. `herdr-last-answer <worker>` prints the worker's last answer text.
2. `herdr-watchdog run --dry-run` finds one pair and prints what it would do.
3. Stop typing in both panes for ten minutes (or lower the threshold for a
   test). The watchdog nudges the pair.

## 8. Troubleshooting

- `last_answer` says "not a herdr subcommand": the model tried shell instead of
  the tool. Put the tool in `--tools` and tell it to call `last_answer`.
- `last_answer` returns "no readable answer yet": the other side has not
  answered. Wait; do not retry in a loop.
- `/tools` does not show a tool: it is not mounted, or `--tools` excluded it.
- Watchdog finds no pair: the pane labels must contain `worker` and `reviewer`.
- Watchdog cannot find `herdr` under systemd: add `~/.local/bin` to the unit's
  `PATH`.
- `refs-reclaim` is not a tool in the profiles by default; mount
  `refs-reclaim/reclaim.ts` and add `refs_reclaim` to `--tools` only where the
  user wants cleanup.

## Safety

- Never run `refs-reclaim apply` without explicit confirmation. It deletes
  worktrees and branches; `apply` needs `confirm=true` and `--yes`.
- Do not edit the agent-state hook that `herdr integration install` wrote;
  herdr overwrites it.
- Read an extension before installing a package that contains it.
