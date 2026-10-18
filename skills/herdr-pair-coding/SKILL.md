---
name: herdr-pair-coding
description: "Set up or operate herdr-pair-coding: worker-reviewer pair coding on top of herdr."
---

# herdr-pair-coding setup

Runs on Linux and macOS; on Windows use WSL. herdr is Unix (Windows is preview),
and refs-reclaim's in-use scan needs Linux `/proc`.

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

## 2. Install herdr

```bash
curl -fsSL https://herdr.dev/install.sh | sh
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"   # Debian does not add these
```

Do not run `herdr integration install <agent>` yet: it needs that agent's config
directory, so it runs after the agent itself is installed (step 3).

Setup does not need herdr running. The pair loop does: it reads panes and sends
keys, so `herdr` must be running and both agents must live in its panes. Outside
herdr, `HERDR_ENV` is not `1` and the tools have nothing to talk to.

## 3. Get the tools

With pi:

```bash
curl -fsSL https://pi.dev/install.sh | sh   # skip if pi is already installed
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"
herdr integration install pi
pi install git:github.com/HYPERVAPOR/herdr-pair-coding
P="$HOME/.pi/agent/git/github.com/HYPERVAPOR/herdr-pair-coding"
```

Restart any agent that was already running before this install: a live process
does not pick up a new package.

`pi install` only auto-loads the role guard (a warning hook, no tools) and the
skill. The tools stay explicit: the profiles mount `last_answer`/`hb_block`, and
`refs-reclaim/reclaim.ts` is mounted only where cleanup is wanted. A bare `pi`
gets no tools from this package.

Updates: pi checks packages at startup and prints `Package Updates Available`;
run `pi update --extensions` (plain `pi update` updates pi itself). That
reconciles the clone, so the skill, the guard, the tool files and the CLI links
all move together, and the profile symlinks above follow. Running agents keep
old code until restarted or `/reload`.

`herdr integration install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts`;
herdr owns that file, do not edit it.

Without pi:

```bash
git clone https://github.com/HYPERVAPOR/herdr-pair-coding "$HOME/herdr-pair-coding"
P="$HOME/herdr-pair-coding"
```

If that agent has a herdr integration, run `herdr integration install <agent>`
after installing it (`herdr integration` lists the kinds).

Put the CLIs on `PATH` either way:

```bash
mkdir -p ~/.local/bin
ln -sfn "$P/herdr-watchdog/herdr-watchdog"       ~/.local/bin/herdr-watchdog
ln -sfn "$P/herdr-last-answer/herdr-last-answer" ~/.local/bin/herdr-last-answer
ln -sfn "$P/refs-reclaim/refs-reclaim"           ~/.local/bin/refs-reclaim

# Most systems do not put ~/.local/bin on PATH (Debian included).
# bash: ~/.bashrc. macOS uses zsh by default: append the same line to ~/.zshrc.
grep -q 'pi/agent/bin' ~/.bashrc 2>/dev/null || \
  printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"' >> ~/.bashrc

for c in herdr-watchdog herdr-last-answer refs-reclaim; do
  command -v "$c" || echo "MISSING: $c"
done
```

At this point the workflow already works without pi: label the panes, start the
agents, run the watchdog. The next two sections are the pi integration.

## 4. Profiles (pi only)

Link the two role files and their rule examples into place:

```bash
mkdir -p ~/.pi/agent/profiles
for f in worker reviewer; do
  ln -sfn "$P/examples/profiles/$f.conf"       ~/.pi/agent/profiles/$f.conf
  ln -sfn "$P/examples/profiles/$f.md.example" ~/.pi/agent/profiles/$f.md.example
done
```

These are symlinks into the package, so `pi update --extensions` updates the
profiles too. Replace a link with a copy if you want to customize it.

Each `.conf` sets a `PROFILE` array. The `bin/pi-profile` script sources it and
starts pi:

```bash
ln -sfn "$P/bin/pi-profile" ~/.local/bin/pi-profile
pi-profile            # inside a labeled pane: worker or reviewer, from the label
pi-profile worker     # outside herdr, or in a pane without a label
```

Inside herdr the pane label is the role. With no argument `pi-profile` starts the
matching profile; an explicit role that disagrees with the label is refused. The
`role-guard` extension repeats the check at session start and warns in the
footer when a pane runs bare pi or the wrong profile.

`~/.local/bin` must be on `PATH`; the CLI links in step 3 use the same directory.

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

This is where a running session starts. Starting `herdr` itself needs an
interactive terminal; your shell tool has no TTY, so ask the user to run
`herdr` and start the two pi panes. Run it in a plain terminal, not inside
another herdr pane. Once the server is up, `herdr pane ...` control commands
work without a TTY.

The watchdog finds pairs by label, not by layout:

```bash
herdr pane rename <worker_pane_id> worker
herdr pane rename <reviewer_pane_id> reviewer
```

The labels only need to contain the words `worker` and `reviewer`, so
`api-worker` / `api-reviewer` also match.

Rename first, then start each agent with `pi-profile` (no argument). A bare `pi`
in a labeled pane, or a profile started before the label was set, shows a role
warning until it is restarted.

A pane that was already running when the package was installed or updated keeps
the tool set its session was created with. Restart it, or `/reload` inside it.

## 6. Watchdog

Start it once herdr is running; it scans live sessions and has nothing to do
before that.

```bash
herdr-watchdog daemon
```

On Linux, as a systemd user service:

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

macOS has no systemd: run `herdr-watchdog daemon` in a terminal, or under
launchd.

The daemon only reads pane state and sends messages. `~/.herdr/watchdog/PAUSE`
pauses it. The watchdog is the only waiter: agents must not poll (`herdr agent
wait`, sleep loops); they end the turn and the watchdog wakes them.

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
  answered. End the turn; do not run `herdr agent wait` or retry in a loop. The
  watchdog sends the wake-up message.
- `/tools` does not show a tool: it is not mounted, or `--tools` excluded it.
- `[Extensions]` lists an extension but its tools are missing: the session was
  created (or resumed) before the extension existed, and pi keeps that session's
  active tool set. `/reload` re-registers and adds them.
- Footer shows `⚠ <role> in <other> pane` or a role notification: the pane label
  and the loaded profile disagree. Restart with `pi-profile` (no argument), or
  rename the pane.
- Watchdog finds no pair: the pane labels must contain `worker` and `reviewer`.
- Watchdog cannot find `herdr` under systemd: add `~/.local/bin` to the unit's
  `PATH`.
- `refs-reclaim apply` refuses on macOS: its in-use scan reads `/proc`, which
  macOS does not have, so it fails closed. `plan`/`archive` still work;
  `--force-unsafe` skips the scan and is not recommended.
- `refs-reclaim` is not a tool in the profiles by default; mount
  `refs-reclaim/reclaim.ts` and add `refs_reclaim` to `--tools` only where the
  user wants cleanup.

## Safety

- Never run `refs-reclaim apply` without explicit confirmation. It deletes
  worktrees and branches; `apply` needs `confirm=true` and `--yes`.
- Do not edit the agent-state hook that `herdr integration install` wrote;
  herdr overwrites it.
- Read an extension before installing a package that contains it.
