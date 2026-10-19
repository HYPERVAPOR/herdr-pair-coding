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

### Updates

pi checks packages at startup and prints `Package Updates Available`; run
`pi update --extensions` (plain `pi update` updates pi itself). That reconciles
the clone, so the skill, the guard, the tool files, the CLI links and the
profile symlinks from step 4 all move together. Running agents keep old code
until restarted or `/reload`.

A pin (`pi install git:...@v1`, an `extensions.lock`, or a copy instead of the
symlinks) does not move on `pi update --extensions`. To take an update, drop or
bump the pin and reconcile:

```bash
pi install git:github.com/HYPERVAPOR/herdr-pair-coding      # default branch
pi install git:github.com/HYPERVAPOR/herdr-pair-coding@<new-ref>   # or a new pin
pi update --extensions
```

Restart each pane (or `/reload` in it) after an update before trusting a
resume: the resume command comes from the extensions the *running* session
loaded, so an old session keeps reporting the old one.

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

# Neither directory is on PATH by default (Debian included). This only reports;
# it never edits your rc files.
missing=
for dir in "$HOME/.local/bin" "$HOME/.pi/agent/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) missing="$missing $dir" ;; esac
done
if [ -n "$missing" ]; then
  echo "not on PATH:$missing"
  case "${SHELL##*/}" in
    zsh)  echo "zsh:  add both to PATH in ${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) echo "bash: add both to PATH in ~/.bashrc (login shells read ~/.bash_profile: source ~/.bashrc there)" ;;
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

That check is the whole step when `PATH is fine`. When it is not, add the two
directories the way your shell wants it, and keep the choice yours: rc files are
personal. The one-liner, if you want it appended:

```bash
printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
```

Appending blindly is wrong when the rc is a symlink into a dotfiles repo (stow
and friends): the line then lands in that repo. Put it wherever you keep shell
config, and re-check with the `command -v` loop above.

Bash has two startup files: interactive non-login shells read `~/.bashrc`,
login shells read `~/.bash_profile` (which usually sources `~/.bashrc`). zsh
reads `${ZDOTDIR:-$HOME}/.zshrc` interactively and `.zshenv` always; fish uses
`~/.config/fish/conf.d/*.fish` with `fish_add_path`. A systemd user unit reads
none of them, which is why the watchdog unit in step 7 sets `PATH` explicitly.


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
The profiles also mount `resume-profile/resume_argv.ts` (next section), and
`pi-profile` exports `HERDR_PAIR_PROFILE=<profile>` so that file knows which
profile it is running under.

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

## 5. Resume after a herdr restart

Without this step herdr brings a pi pane back with its own built-in command,
`pi --session <file>`: a bare pi. The conversation survives, the role does not
(no role prompt, no `--tools` whitelist, no `last_answer`/`hb_block`).

With the profiles from step 4 mounted, each pane reports a resume command of its
own and herdr prefers it:

```text
pi-profile <profile> --session <the same session file>
```

`resume-profile/resume_argv.ts` finds the role like this:

1. `HERDR_PAIR_PROFILE`, exported by `bin/pi-profile`. The normal path.
2. Otherwise an exact `label = profile` line in `~/.pi/agent/profiles/labels.conf`.
3. Otherwise nothing is reported and the pane keeps herdr's built-in resume.

Case 3 is on purpose: a bare `pi` sitting in a labelled pane is not silently
upgraded into a profile on the next restart. Start it with `pi-profile` and it
stays a profile.

- It reports as source `herdr:pi`, agent `pi` — the same reporter as herdr's own
  pi integration — so it appends to the pane's agent instead of claiming it.
- It reports at session start, at every turn start and at every settle. herdr
  keeps the command while that agent holds the pane, and herdr's own
  state-only reports (they carry no command) do not clear it: measured on
  0.9.3 by running a full turn and re-reading the persisted session file.
- A report can be dropped. herdr only stores the command once it recognizes the
  pane's agent, and at session start the report often beats that detection: the
  answer is `resume_not_accepted`, or nothing while the previous command stays.
  So the report is retried with a fresh seq (0 / 250 / 750 / 1500 ms, under 4 s,
  then it gives up silently) and a newer state cancels the older retry, so a
  slow `working` can never land after a newer `idle`. Before that retry existed,
  "start pi, restart herdr without asking anything" came back as bare pi, and a
  changed profile came back as the old role.
- The resumed command is `pi-profile`, so `~/.local/bin` (or wherever the link
  lives) must be on `PATH` — step 3.
- herdr writes the command to
  `~/.config/herdr/sessions/<name>/session.json` as `agent_resume.argv`.
  herdr 0.9.3 does this. herdr's docs label self-reported resume commands
  "0.10.0 and newer" for third-party agents; we measured 0.9.3, so treat
  `agent_resume` showing up in `session.json` as the truth for your build. A
  version that ignores the command accepts the report and restores bare pi, and
  nothing else changes.
- A pane whose session was started before this package (or before an update) has
  no reporter loaded: restart it with `pi-profile`, or `/reload`.

Turn the whole thing off (built-in resume included) in
`~/.config/herdr/config.toml`:

```toml
[session]
resume_agents_on_restore = false
```

then `herdr server reload-config`, or restart herdr.

Verify on a session you do not mind restarting:

```bash
herdr --session resume-test          # its own server and socket
# in a pane: label it (step 6), then start pi-profile there
herdr session stop resume-test
herdr --session resume-test          # the pane should come back as the profile
python3 -c "import json; d=json.load(open('$HOME/.config/herdr/sessions/resume-test/session.json')); print([p.get('agent_resume') for w in d['workspaces'] for t in w['tabs'] for p in t['panes'].values()])"
```

`session.json` is pretty-printed, so a one-line `grep` never matches it: read the
JSON. One entry per pane; `None` means herdr has no resume command for it (bare
pi).

A pane restored as a profile shows `HERDR_PAIR_PROFILE` in its environment; a
pane restored as bare pi does not.

## 6. Label the panes

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

For custom profile names, add exact mappings to
`~/.pi/agent/profiles/labels.conf`, one `label = profile` per line (for example
`worker = my-worker`). `pi-profile` uses those before guessing worker/reviewer.

A pane that was already running when the package was installed or updated keeps
the tool set its session was created with. Restart it, or `/reload` inside it.

## 7. Watchdog

Start it once herdr is running; it scans live sessions and has nothing to do
before that.

```bash
herdr-watchdog daemon
```

On Linux, as a systemd user service:

A user unit reads no shell rc at all (`~/.bashrc`, `.zshrc`, fish conf.d — none),
so the `Environment=PATH=` line is not optional: without it the unit cannot find
`herdr-watchdog`. It lists `~/.local/bin` and `~/.pi/agent/bin` by hand, which is
exactly what the shell normally does from wherever the user put them.

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
systemctl --user daemon-reload
systemctl --user enable --now herdr-watchdog
herdr-watchdog top        # read-only live view
```

macOS has no systemd: run `herdr-watchdog daemon` in a terminal, or under
launchd.

The daemon only reads pane state and sends messages. `~/.herdr/watchdog/PAUSE`
pauses it. The watchdog is the only waiter: agents must not poll (`herdr agent
wait`, sleep loops); they end the turn and the watchdog wakes them.

## 8. Verify

CLI checks:

1. `herdr-last-answer <worker>` prints the worker's last answer text.
2. `herdr-watchdog run --dry-run` finds one pair and prints what it would do.
3. Stop typing in both panes for ten minutes (or lower the threshold for a
   test). The watchdog nudges the pair.

## 9. Troubleshooting

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
- A restarted pane drops to a shell with `pi-profile: this pane is labeled 'x';
  refusing to start the 'y' profile`: the resume command carries the profile the
  pane was *started* with, and the label changed since (`herdr pane rename`).
  Start the agent again with `pi-profile` (no argument) so it reports the role
  that matches the label.
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
