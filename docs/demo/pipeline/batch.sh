#!/usr/bin/env bash
# One real take per herdr theme: 3 pairs + watchdog top, then GIF.
set -uo pipefail
S=/tmp/gifdemo
cd "$S" || exit 1

for theme in "$@"; do
	printf 'onboarding = false\n[ui.toast]\ndelivery = "terminal"\n[theme]\nname = "%s"\nauto_switch = false\n[ui]\nstatus_indicators = "symbols"\n' "$theme" >theme.toml
	herdr session stop gifdemo >/dev/null 2>&1
	herdr session delete gifdemo >/dev/null 2>&1
	git -C work reset --hard -q
	git -C work clean -fdq
	rm -f END refresh "take-$theme.cast"
	echo "=== $theme: recording"
	timeout 280 venv/bin/python record.py --cols 175 --rows 48 --duration 240 \
		--stop-file "$S/END" --hold 4 --out "take-$theme.cast" -- "$S/driver.sh" | tail -1
	rm -f "$HOME/.herdr/watchdog/PAUSE"
	herdr session stop gifdemo >/dev/null 2>&1
	herdr session delete gifdemo >/dev/null 2>&1
	sed -n '3,20p' driver.log
	rm -rf "r-$theme"
	venv/bin/python render.py "take-$theme.cast" "r-$theme" --fps 4 --size 13 \
		--theme "$theme" --speed 1.5 --max-hold 1.6 | tail -1
	ffmpeg -y -loglevel error -f concat -safe 0 -i "r-$theme/frames.txt" -fps_mode vfr \
		-lavfi "split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=none" \
		"pair-demo-$theme.gif"
	ls -lh "pair-demo-$theme.gif"
done
rm -f "$HOME/.herdr/watchdog/PAUSE"
echo "ALL DONE"
