---
name: pi-dev-bundle
description: Install and operate pi-dev-bundle, a worker-reviewer pair-coding setup for pi + herdr (watchdog, last_answer tool, worktree cleanup). Use when the user wants two agents to work as worker and reviewer under herdr, or asks to set up pi-dev-bundle.
---

# pi-dev-bundle setup

Goal: the user ends with two panes, `worker` and `reviewer`, running pi with the
right tools, plus a watchdog that nudges the pair when it stalls.

Work through the steps in order. Check before you install; ask before you write
to the user's dotfiles or start a background service.

## 1. Preflight

```bash
node --version        # 22.19 or newer
python3 --version
git --version
herdr --version
pi --version
```

Report what is missing. Do not install anything until the user agrees.

## 2. Install pi and herdr

```bash
curl -fsSL https://pi.dev/install.sh | sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi
```

`herdr integration install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts`.
herdr owns that file; do not edit it.

The user still needs to log in to a model provider inside pi (`/login`). Ask
them to do it; you cannot.

herdr has to be running (`herdr`) and the agents have to live in its panes.
Outside herdr, `HERDR_ENV` is not `1` and the pair-coding tools have nothing to
talk to.

## 3. Install the bundle

```bash
pi install git:github.com/HYPERVAPOR/pi-dev-bundle
PKG="$HOME/.pi/agent/git/github.com/HYPERVAPOR/pi-dev-bundle"
```

That installs the code. It does not mount every tool: profiles decide which
tools each role sees.

## 4. Profiles

Create `~/.pi/agent/profiles/worker.conf` and `reviewer.conf` (copies live in
the bundle under `examples/profiles/`). Each file sets a `PROFILE` array; a
small shell function runs it:

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
- `--append-system-prompt` points at the user's own rule files. Create them, or
  remove those lines.

The worker gets `read,write,edit,ls,bash`. The reviewer additionally gets
`last_answer` and `hb_block`, and mounts their two extension files.

Label the panes so the watchdog can find the pair:

```bash
herdr pane rename <worker_pane_id> worker
herdr pane rename <reviewer_pane_id> reviewer
```

The labels only need to contain the words `worker` and `reviewer`.

## 5. Watchdog

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
Environment=PATH=%h/.local/bin:%h/.pi/agent/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 %h/.pi/agent/git/github.com/HYPERVAPOR/pi-dev-bundle/herdr-watchdog/herdr-watchdog daemon
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

## 6. Verify

1. Start the worker pane with `pi-profile worker`, the reviewer with
   `pi-profile reviewer`.
2. In the reviewer, run `/tools`. It should list `last_answer` and `hb_block`
   with `✓`.
3. Ask the reviewer to read the worker's last answer. It must use the
   `last_answer` tool, never `herdr agent herdr-last-answer`.
4. Run `herdr-watchdog run --dry-run` for one silent pass; it should find one
   pair and print what it would do.
5. Stop typing in both panes for ten minutes (or lower the threshold for a
   test). The watchdog should nudge the pair.

## 7. Troubleshooting

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
- Do not edit `herdr-agent-state.ts`; herdr overwrites it.
- Read an extension before installing a package that contains it.
