# Demo GIF pipeline

`../pair-demo.gif` is a 12-second cut of a real session recorded from herdr,
not a mock-up (the untrimmed 46-second take is
`casts/pair-demo-catppuccin.cast`). This directory is the pipeline that produces
it, kept so the demo can be re-recorded or re-rendered later.

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

The take opens with the pair **blocked** (`hb_block:true 😴`, `hb:true` and
`muted` in the top pane) as if the previous round had ended that way. The human
then prompts the reviewer:

> Review the clamp change the worker just made. Start by calling hb_block with
> action=unblock and reason="starting review" … Then read the worker answer with
> herdr-last-answer, check the diff, run the test suite yourself …

so the unblock is a real `true -> false` transition on screen: the footer flips
to `hb_block:false 👂`, the top pane flips to `hb:false`, the quiet gauge starts
moving again, and the reviewer's verdict ends with "heartbeat left unblocked".

Everything else is real too: the herdr TUI, tab/pane labels, both `pi-profile`
sessions, the worker turn (read, edit, unittest, answer), the reviewer turn, and
the `herdr-watchdog top` pane reading the watchdog's own snapshot file.

## Recording notes

1. **Terminal capability replies.** A bare pty answers no queries, so herdr fell
   back to a 256-colour palette and catppuccin's mauve/pink/peach were
   quantised into pale cube colours. `record.py` answers DA1, OSC 10/11, DSR
   996, cell-size and DECRQM, and herdr emits exact `#rrggbb` again.
2. **Renderer colour bug (fixed).** `pyte` hands colours back as bare hex
   (`"cba6f7"`, no `#`); `resolve()` only accepted `#rrggbb`, so every
   truecolor/256 SGR fell through to the default foreground and 256-colour
   backgrounds vanished — the UI collapsed to "base + text".
   `shots/colour-chart.png` is the regression test.
3. **Font fallback is per glyph, and picky about width.** The Nerd Font lacks
   `✦ ✧ ➤`; Noto CJK has `▱ ♡` but as full-width glyphs, which spill into the
   next cell. `render.py` picks the first font that has the glyph *and* draws it
   one cell wide (Nerd Font → DejaVu Sans Mono symbols → CJK → emoji), and
   scales down anything that is still too wide.
4. **English prompts.** The panes run pi with `HOME=<demo home>`
   (`make-demo-home.sh`), whose `profiles/{worker,reviewer}.md` are this repo's
   English example prompts; the user's own role prompts are untouched.
5. **Watchdog state stays in the demo.** The panes get `HB_DIR=/tmp/gifdemo/hb`
   so `hb_block` writes the demo flag instead of the real
   `~/.herdr/watchdog`. Without it the reviewer's unblock lands in the real
   directory and `top` never sees it.
6. **Demo tuning, outside the product.** The system watchdog daemon is paused
   for the take (`~/.herdr/watchdog/PAUSE`, removed afterwards). `feeder.py`
   runs the demo copy of `herdr-watchdog` in dry mode every 3 s so the `top`
   pane stays live without sending anything. The demo copy differs from the
   shipped tool only in `STALE_SEC = 3`, `INTERVAL = 3`, and writing the
   snapshot on a dry pass. The theme comes from a throwaway
   `HERDR_CONFIG_PATH`. The driver resets the work repo to its root commit and
   wipes the demo watchdog state before each take.

## Re-render without recording

```bash
python3 -m venv .venv && .venv/bin/pip install pyte pillow fonttools
.venv/bin/python pipeline/render.py casts/pair-demo-catppuccin.cast /tmp/fr \
    --fps 5 --size 16 --theme catppuccin --speed 1.5 --max-hold 1.6 \
    --start 4.2 --end 46
ffmpeg -y -f concat -safe 0 -i /tmp/fr/frames.txt -fps_mode vfr \
    -lavfi "split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=none" \
    ../pair-demo.gif
```

`--size 16` gives a 1678x1056 frame (175x48 cells at 9.6x22 px). `--start` /
`--end` cut on cast time — events before `--start` are replayed silently, so the
screen still needs the whole history; nothing is dropped. `--speed` scales the
playback, `--max-hold` clamps long static stretches.

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

Fonts — Nerd Font, CJK and emoji; the symbol fallback is stock DejaVu Sans Mono:

```bash
curl -L -o /tmp/jbm.zip https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip
unzip -j /tmp/jbm.zip 'JetBrainsMonoNLNerdFontMono-*.ttf' -d ~/.local/share/fonts
curl -L -o /tmp/ne.zip 'https://gwfh.mranftl.com/api/fonts/noto-emoji?download=zip&subsets=emoji&formats=ttf'
unzip -j /tmp/ne.zip 'noto-emoji-v65-emoji-regular.ttf' -d ~/.local/share/fonts
# CJK: NotoSansCJKsc-{Regular,Bold}.otf   symbols: /usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
fc-cache -f
```

Wide characters take two cells and are baseline-aligned with the primary font.
