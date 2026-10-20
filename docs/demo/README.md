# Demo GIF pipeline

`../pair-demo.gif` is a real 35-second session recorded from herdr, not a
mock-up. This directory is the pipeline that produces it, kept so the demo can
be re-recorded or re-rendered later.

```
pipeline/record.py           pty -> asciinema v2 cast          (stdlib only)
pipeline/render.py           cast -> PNG frames + frames.txt   (pyte, Pillow, fonttools)
pipeline/driver.sh           choreography: TUI foreground, herdr CLI + watchdog background
pipeline/feeder.py           keeps the `top` mirror fresh without acting
pipeline/batch.sh            one take per herdr theme
pipeline/make-demo-home.sh   throwaway HOME: English role prompts + pi theme
pipeline/make-demo-tool.sh   patched copy of herdr-watchdog (3 s heartbeat)
pipeline/make-work-repo.sh   the mathkit repo the workers edit
casts/                       the recorded raw session (re-render without re-recording)
shots/                       stills used to check colours and themes
```

## What the take shows

Visible tab (`pair`):

```
+----------------------+------------------+
|                      | reviewer         |
| worker               +------------------+
|                      | watchdog top     |
+----------------------+------------------+
```

`pair-api` and `pair-docs` sit idle in their own tabs so `herdr-watchdog top`
has a pair tree to draw (`3 pairs · 3s/pass`, ECG, quiet gauges).

Everything on screen is real: the herdr TUI, the tab/pane labels, both
`pi-profile` sessions, the worker turn (read, edit, unittest, answer), the
watchdog message, the reviewer turn, and the `herdr-watchdog top` pane reading
the watchdog's own snapshot file.

## Recording notes

1. **Terminal capability replies.** A bare pty answers no queries, so herdr fell
   back to a 256-colour palette and catppuccin's mauve/pink/peach were
   quantised into pale cube colours. `record.py` answers DA1, OSC 10/11, DSR
   996, cell-size and DECRQM, and herdr emits exact `#rrggbb` again.
2. **Renderer colour bug (fixed).** `pyte` hands colours back as bare hex
   (`"cba6f7"`, no `#`); `resolve()` only accepted `#rrggbb`, so every
   truecolor/256 SGR fell through to the default foreground and 256-colour
   backgrounds vanished — the UI collapsed to "base + text". `shots/colour-chart.png`
   is the regression test: 16-colour, 256-colour and truecolor all render.
3. **English prompts.** The panes run pi with `HOME=<demo home>`
   (`make-demo-home.sh`), whose `profiles/{worker,reviewer}.md` are this repo's
   English example prompts; the user's own role prompts are untouched.
4. **Demo tuning, outside the product.** The system watchdog daemon is paused
   for the take (`~/.herdr/watchdog/PAUSE`, removed afterwards). `feeder.py`
   runs the demo copy of `herdr-watchdog` in dry mode every 3 s so the `top`
   pane stays live without sending anything; one real pass runs with `--tab`
   when the active pair goes quiet. The demo copy differs from the shipped tool
   only in `STALE_SEC = 3`, `INTERVAL = 3`, and writing the snapshot on a dry
   pass. The theme comes from a throwaway `HERDR_CONFIG_PATH`.

## Re-render without recording

```bash
python3 -m venv .venv && .venv/bin/pip install pyte pillow fonttools
.venv/bin/python pipeline/render.py casts/pair-demo-catppuccin.cast /tmp/fr \
    --fps 4 --size 13 --theme catppuccin --speed 1.5 --max-hold 1.6
ffmpeg -y -f concat -safe 0 -i /tmp/fr/frames.txt -fps_mode vfr \
    -lavfi "split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=none" \
    ../pair-demo.gif
```

`--start/--end` are not implemented yet; to cut a range, feed the cast through
`render.py` after filtering its events, or re-record with `batch.sh`.

## Record from scratch

The scripts hardcode `/tmp/gifdemo` as the working directory (`S=`, `HB_DIR`,
the feeder trigger), so stage them there:

```bash
mkdir -p /tmp/gifdemo && cd /tmp/gifdemo
cp <repo>/docs/demo/pipeline/{record,render,feeder}.py .
cp <repo>/docs/demo/pipeline/{driver,batch,make-demo-home,make-demo-tool,make-work-repo}.sh .
chmod +x *.sh *.py
./make-demo-tool.sh      # patched herdr-watchdog
./make-work-repo.sh      # throwaway mathkit repo
./make-demo-home.sh      # English role prompts + pi theme catppuccin-mocha
python3 -m venv venv && venv/bin/pip install pyte pillow fonttools
./batch.sh catppuccin    # one take per theme
```

Fonts (all three are needed — the TUI uses Nerd Font icons, CJK and emoji):

```bash
curl -L -o /tmp/jbm.zip https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip
unzip -j /tmp/jbm.zip 'JetBrainsMonoNLNerdFontMono-*.ttf' -d ~/.local/share/fonts
curl -L -o /tmp/ne.zip 'https://gwfh.mranftl.com/api/fonts/noto-emoji?download=zip&subsets=emoji&formats=ttf'
unzip -j /tmp/ne.zip 'noto-emoji-v65-emoji-regular.ttf' -d ~/.local/share/fonts
# CJK: NotoSansCJKsc-{Regular,Bold}.otf
fc-cache -f
```

Per-character fallback is picked from each font's cmap; wide characters take two
cells and are baseline-aligned with the primary font.
