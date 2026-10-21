---
name: herdr-pair-coding
description: "Set up or operate herdr-pair-coding: worker-reviewer pair coding on top of herdr."
license: MIT
---

# herdr-pair-coding

Two panes, `worker` and `reviewer`, each running a pi profile, plus a watchdog
that nudges the pair when it stalls. The three tools are plain CLIs and only need
herdr; pi turns them into tools and adds the role profiles. Linux and macOS; on
Windows use WSL (refs-reclaim needs Linux `/proc`).

## Start here

`command -v pi-profile herdr-watchdog herdr-last-answer` — all found means it is
installed: go to **B. Use**. Anything missing: **A. Setup**, once. A flag, a
path, the systemd unit, resume details: **C. Reference**.

## A. Setup (once)

### A1. Preflight

```bash
herdr --version && python3 --version    # git only for refs-reclaim
```

### A2. herdr

```bash
curl -fsSL https://herdr.dev/install.sh | sh
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"   # this shell only
```

Do not run `herdr integration install <agent>` yet: it needs the agent's config
directory, so it comes after A3. Setup does not need herdr running; B does.

### A3. pi, the package, the CLI links

```bash
curl -fsSL https://pi.dev/install.sh | sh         # skip if pi is already there
herdr integration install pi
pi install git:github.com/HYPERVAPOR/herdr-pair-coding
P="$HOME/.pi/agent/git/github.com/HYPERVAPOR/herdr-pair-coding"

mkdir -p ~/.local/bin
for c in herdr-watchdog herdr-last-answer refs-reclaim; do
  ln -sfn "$P/$c/$c" ~/.local/bin/$c
done
```

`pi install` auto-loads only the role guard (a warning hook, no tools) and this
skill. The rest stays explicit: the profiles mount `last_answer`/`hb_block`,
`refs-reclaim/reclaim.ts` only where cleanup is wanted. A bare `pi` gets no tools.

Neither `~/.local/bin` nor `~/.pi/agent/bin` is on `PATH` by default (Debian and
macOS included). This only reports; it never edits your rc files:

```bash
missing=
for dir in "$HOME/.local/bin" "$HOME/.pi/agent/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) missing="$missing $dir" ;; esac
done
if [ -n "$missing" ]; then
  echo "not on PATH:$missing"
  case "${SHELL##*/}" in
    zsh)  echo "zsh:  add both to PATH in ${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) echo "bash: add both to PATH in ~/.bashrc (login shells read ~/.bash_profile)" ;;
    fish) echo "fish: fish_add_path $HOME/.local/bin $HOME/.pi/agent/bin" ;;
    *)    echo "unknown shell '${SHELL##*/}': add both directories to PATH yourself" ;;
  esac
else
  echo "PATH is fine"
fi

for c in herdr-watchdog herdr-last-answer refs-reclaim pi-profile; do
  command -v "$c" >/dev/null || echo "MISSING: $c"
done
```

`PATH is fine` is the whole step. If it is not, add the two directories the way
your shell wants it (C.2) and re-run the `command -v` loop.

No pi? Clone instead and skip A4/A5:

```bash
git clone https://github.com/HYPERVAPOR/herdr-pair-coding "$HOME/herdr-pair-coding"
P="$HOME/herdr-pair-coding"
herdr integration install <agent>      # if that agent has one; `herdr integration` lists them
```

### A4. Profiles

```bash
mkdir -p ~/.pi/agent/profiles
for f in worker reviewer; do
  ln -sfn "$P/examples/profiles/$f.conf"       ~/.pi/agent/profiles/$f.conf
  ln -sfn "$P/examples/profiles/$f.md.example" ~/.pi/agent/profiles/$f.md.example
done
ln -sfn "$P/bin/pi-profile" ~/.local/bin/pi-profile
```

Symlinks into the package, so updates reach them; replace with a copy to
customize. Inside herdr the pane label is the role: `pi-profile` with no argument
starts that profile and refuses a role that disagrees with the label. Outside
herdr, name it: `pi-profile worker`. What the confs set, and custom profile
names: C.1.

### A5. Resume after a herdr restart

The profiles already mount `resume-profile/resume_argv.ts`; `bin/pi-profile`
exports what it needs. Nothing else to install — a pane started with
`pi-profile` comes back as that profile instead of bare pi. Semantics, the
version caveat and the off switch: C.4.

### A6. Updates and pins

```bash
pi update --extensions     # reconciles the clone: skill, guard, tools, links
```

A pin (`pi install git:...@v1`, an `extensions.lock`, a copy instead of the
symlinks) does not move on `pi update --extensions`: re-install without the pin,
or with the new one, then run it again. Restart each pane (or `/reload` in it)
afterwards — a running session keeps the code and the resume command it loaded.

Setup ends here. Go to **B**.

## B. Use (every pair)

### B1. 30-second self-check

```bash
command -v pi-profile herdr-watchdog herdr-last-answer refs-reclaim
herdr-watchdog run --dry-run      # inside a pane; outside: HERDR_SESSION=<name> first
```

Four commands and a dry run that names a tab: the tooling is there.

### B2. Create the pair

herdr is already running (you are in one of its panes), so build the pair
yourself — do not ask the user to do it. Two panes, labelled, each with its
profile:

```bash
NEW=$(herdr tab create --cwd "$PWD" --label pair)
W=$(printf %s "$NEW" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr pane rename "$W" worker
SP=$(herdr pane split --pane "$W" --direction right --cwd "$PWD")
R=$(printf %s "$SP" | python3 -c 'import json,sys;d=json.load(sys.stdin)["result"];print((d.get("pane") or d).get("pane_id"))')
herdr pane rename "$R" reviewer
herdr pane run "$W" pi-profile
herdr pane run "$R" pi-profile
```

- `no active workspace` from `tab create`: run `herdr workspace create` once.
- Only if herdr is not running at all (`herdr status`) does this need a human: a
  server start wants an interactive terminal, and a nested herdr is refused.
- Labels first, then `pi-profile`: the label decides the role. `api-worker` /
  `api-reviewer` also match; custom names go in `labels.conf` (C.1).

### B3. Give the worker its first task

```bash
herdr agent prompt "$W" "<the task, one paragraph: repo, scope, what done means>"
```

Nothing moves until you do this: a fresh worker sits idle and the watchdog leaves
an idle, silent pair alone. The reviewer reads answers with `last_answer`.

### B4. Watchdog

```bash
pgrep -af 'herdr-watchdog daemon$'           # a line here = a daemon is running
systemctl --user is-active herdr-watchdog    # when it runs as the C.3 unit
herdr-watchdog daemon                        # only when neither does (systemd: C.3)
```

`run --dry-run` proves the pair is parsed and what it would say, not that a daemon
is alive — `pgrep` does. `herdr-watchdog top` is a human's live view: curses, dies
without a TTY, so an agent must not call it.

### B5. Wrap up

`herdr tab close <tab_id>` ends the pair; worktrees and branches are
`refs-reclaim`'s job (C.6), and nothing is deleted without `--yes`.

## C. Reference

### C.1 pi-profile, profiles, labels

`~/.pi/agent/profiles/<name>.conf` sets a `PROFILE` array that
`bin/pi-profile` sources before `exec pi`:

- `-ne` no discovered extensions, `-ns` no skills, `-np` no prompt templates,
  `--no-mcp` no MCP servers: the profile mounts exactly what it lists.
- `--tools` is a whitelist; a tool missing there is invisible to the model.
  worker: `read,write,edit,ls,bash`; reviewer adds `last_answer,hb_block`.
- `--append-system-prompt` takes a path or literal text. A missing file is
  appended as the literal path, not an error — check the paths exist.

`pi-profile` also exports `HERDR_PAIR_PROFILE=<profile>` and the conf sets
`PI_ROLE`. `role-guard` compares label and profile at session start and warns in
the footer when they disagree. Exact label → profile mappings go in
`~/.pi/agent/profiles/labels.conf`, one `label = profile` per line; that table is
also the only fallback `resume_argv.ts` reads, so a profile started by hand
(`pi -e ...`) needs either `HERDR_PAIR_PROFILE` or a line there.

Without pi: call the CLIs yourself — `herdr-last-answer <worker>` for the answer
text, `herdr-watchdog set --action block --reason "..."` to silence the watchdog.

### C.2 PATH per shell

- bash: interactive non-login reads `~/.bashrc`; login reads `~/.bash_profile`
  (which usually sources `~/.bashrc`).
- zsh: interactive reads `${ZDOTDIR:-$HOME}/.zshrc`; `.zshenv` always.
- fish: `~/.config/fish/conf.d/*.fish`, or `fish_add_path`.
- unknown shell: add the two directories yourself.

Appending blindly is wrong when the rc is a symlink into a dotfiles repo (stow
and friends): the line lands in that repo. Put it where you keep shell config.
A systemd user unit reads none of this — C.3 sets `PATH` by hand for that reason.

### C.3 systemd unit (Linux)

A user unit reads no shell rc, so `Environment=PATH=` is not optional:

```ini
[Unit]
Description=herdr-watchdog
After=default.target

[Service]
Type=simple
Environment=PATH=%h/.local/bin:%h/.pi/agent/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 %h/.local/bin/herdr-watchdog daemon
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now herdr-watchdog
```

macOS has no systemd: `herdr-watchdog daemon` in a terminal, or under launchd.

### C.4 Resume: what comes back, and when

herdr's own restore runs `pi --session <file>`: a bare pi, role lost. With
`resume_argv.ts` mounted the pane reports `pi-profile <profile> --session <file>`
instead, as source `herdr:pi` / agent `pi` (the same reporter as herdr's pi
integration, so it appends instead of claiming the pane).

- Role: `HERDR_PAIR_PROFILE`, else an exact `label = profile` in `labels.conf`,
  else nothing is reported and the pane keeps the built-in resume. A bare `pi` in
  a labelled pane is not silently upgraded — start it with `pi-profile`.
- Reported at session start, turn start and settle. herdr stores it once it
  recognizes the agent, so an early report can be dropped: it is retried with a
  fresh seq (0/250/750/1500 ms, under 4 s, then silently), and a newer state
  cancels an older retry so a slow `working` cannot land after a newer `idle`.
- Version: measured on herdr 0.9.3; the docs label self-reported resume commands
  "0.10.0 and newer" for third-party agents. Treat `agent_resume` appearing in
  `session.json` as the truth for your build; a build that ignores it accepts the
  report and restores bare pi.
- Off switch (built-in resume included), in `~/.config/herdr/config.toml`, then
  `herdr server reload-config`:

```toml
[session]
resume_agents_on_restore = false
```

Verify on a session you do not mind restarting. Attaching needs a TTY, so start
the client under tmux; every `herdr --session resume-test …` control command then
works without one:

```bash
RV="env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH -u HERDR_SESSION herdr --session resume-test"
tmux new-session -d -s rv "$RV"
herdr --session resume-test pane list                 # label a pane, run pi-profile there
herdr session stop resume-test && tmux kill-session -t rv
tmux new-session -d -s rv "$RV"                       # bring it back
```

`HERDR_*` is cleared for the client because a nested herdr is refused; every
`herdr --session resume-test …` control command works without a TTY.

After the restart, read the stored command:

```bash
python3 -c "import json; d=json.load(open('$HOME/.config/herdr/sessions/resume-test/session.json')); print([p.get('agent_resume') for w in d['workspaces'] for t in w['tabs'] for p in t['panes'].values()])"
```

Finally `herdr session stop resume-test && tmux kill-session -t rv`. `session.json`
is pretty-printed, so a one-line `grep` never matches it: read the JSON, one entry
per pane, `None` meaning bare pi. A restored profile pane has
`HERDR_PAIR_PROFILE` in its environment; a bare pi pane does not.

### C.5 Troubleshooting

- `last_answer` says "not a herdr subcommand": the model used shell. Put the tool
  in `--tools` and tell it to call `last_answer`.
- `last_answer` returns "no readable answer yet": the other side has not
  answered. End the turn; do not poll with `herdr agent wait` or a sleep loop.
- `/tools` misses a tool: not mounted, or excluded by `--tools`. An extension
  listed in `[Extensions]` with no tools: the session predates it — `/reload`.
- Footer shows `⚠ <role> in <other> pane`, or a restarted pane drops to a shell
  with `this pane is labeled 'x'; refusing to start the 'y' profile`: the label
  and the loaded/saved profile disagree. Rename or start `pi-profile` (no
  argument) again so it reports the role that matches the label.
- Watchdog finds no pair: the labels must contain `worker` and `reviewer`; it
  also leaves an idle, silent pair alone by design (`run --dry-run` says why).
- Watchdog cannot find `herdr` under systemd: `PATH` in the unit (C.3).
- `refs-reclaim apply` refuses on macOS: its in-use scan reads `/proc`, so it
  fails closed. `plan`/`archive` still work; `--force-unsafe` is not recommended.
- Double-clicking the indicator does nothing: mouse input only reaches components
  in fullscreen mode, and herdr captures it for its own UI by default; `/hb`
  always works.
- Outside herdr the CLIs need the session: `HERDR_SESSION=<name>` (and for
  `herdr` itself `--session <name>`), because a live `HERDR_SOCKET_PATH` wins.

### C.6 The pair's CLIs

| what | command |
| --- | --- |
| worker's last answer | `herdr-last-answer <worker>` (tool `last_answer`) |
| silence the heartbeat | `herdr-watchdog set --action block --reason "..."` (tool `hb_block`; you: `/hb`, always; double-click the indicator where the host forwards mouse events) |
| what would the watchdog do | `herdr-watchdog run --dry-run` |
| live view / pid | `herdr-watchdog top` |
| pause everything | `~/.herdr/watchdog/PAUSE` |
| reclaim worktrees/branches | `refs-reclaim plan` → `refs-reclaim archive` → `apply --yes` |

The watchdog is the only waiter: agents must not poll; they end the turn and the
watchdog wakes them.

## Safety

- Never `refs-reclaim apply` without explicit confirmation: it deletes worktrees
  and branches, and wants `confirm=true` plus `--yes`.
- Pass `--authors` (or `REFS_RECLAIM_AUTHORS`) on every `plan`/`apply`: `T1` only
  proves the content is already in the base branch, it says nothing about who owns
  the ref. Without it the author gate reports `AU skip` and foreign branches are
  `T1` just like yours.
- `--only` replaces the default scope; it never adds to it. Check the `[P4]`/`[P5]`/
  `[P6]` lines in the output to see which stage actually ran.
- Do not edit `~/.pi/agent/extensions/herdr-agent-state.ts`; herdr owns it.
- Read an extension before installing a package that carries it.
