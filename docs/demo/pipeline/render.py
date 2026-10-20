#!/usr/bin/env python3
"""Render an asciinema v2 cast into PNG frames + a GIF-friendly concat list.

Fonts: a monospace Nerd Font for text and icons, with fallbacks for CJK and
emoji selected per character from each font's cmap.

Usage: render.py cast outdir [--fps 4] [--size 14] [--theme catppuccin]
"""
import argparse
import json
import re
import os
import unicodedata

import pyte
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

THEMES = {
    # name: (default fg, default bg, 16 ansi colors)
    "catppuccin": ("#cdd6f4", "#1e1e2e", [
        "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
        "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]),
    "catppuccin-latte": ("#4c4f69", "#eff1f5", [
        "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
        "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"]),
    "tokyo-night": ("#c0caf5", "#1a1b26", [
        "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
        "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]),
    "dracula": ("#f8f8f2", "#282a36", [
        "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
        "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
    "nord": ("#d8dee9", "#2e3440", [
        "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
        "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
    "gruvbox": ("#ebdbb2", "#282828", [
        "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
        "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
    "solarized": ("#839496", "#002b36", [
        "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
        "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
}
NAMED = {}
for i, n in enumerate("black red green brown blue magenta cyan white".split()):
    NAMED[n] = i
    NAMED["bright" + n] = i + 8
NAMED.update({"gray": 7, "grey": 7})

STYLES = ("", "bold", "italic", "bolditalic")


HEX6 = re.compile(r"^[0-9a-fA-F]{6}$")


def resolve(color, theme, default):
    """pyte hands back bare hex ("cba6f7") for 256-colour and truecolor SGR."""
    if color in (None, "default"):
        return default
    if color.startswith("#"):
        return color
    if HEX6.match(color):
        return "#" + color
    if color in NAMED:
        return theme[2][NAMED[color]]
    return default


def is_wide(ch):
    return bool(ch) and unicodedata.east_asian_width(ch) in ("W", "F")


def cmap_of(path):
    try:
        return set(TTFont(path, lazy=True).getBestCmap())
    except Exception:
        return set()


class Fallback:
    """Primary Nerd Font + per-character fallbacks for CJK and emoji."""

    def __init__(self, path, size, cjk_path, emoji_path):
        self.faces = {}
        self.chains = {"primary": [], "cjk": [], "emoji": []}
        suffixes = {"": "", "bold": "-Bold", "italic": "-Italic", "bolditalic": "-BoldItalic"}
        for style in STYLES:
            p = path if not suffixes[style] else path.replace("-Regular", suffixes[style])
            if not os.path.exists(p):
                p = path
            self.faces[("primary", style)] = ImageFont.truetype(p, size)
        primary_cmap = cmap_of(path)
        self.chains["primary"] = [primary_cmap]
        self.chains["cjk"] = [cmap_of(cjk_path)] if cjk_path else []
        self.chains["emoji"] = [cmap_of(emoji_path)] if emoji_path else []

        base = self.faces[("primary", "")]
        target = 2 * base.getlength("M")
        for kind, p, probe in (("cjk", cjk_path, "\u4e2d"), ("emoji", emoji_path, "\U0001F634")):
            if not p:
                continue
            s = self._fit(p, size, target, probe)
            bold = p.replace("-Regular", "-Bold")
            for style in STYLES:
                src = bold if (style in ("bold", "bolditalic") and os.path.exists(bold)) else p
                self.faces[(kind, style)] = ImageFont.truetype(src, s)

        self.cache = {}
        self.width = {}
        self.cell = base.getlength("M")
        self.asc = base.getmetrics()[0]

    @staticmethod
    def _fit(path, size, target, probe):
        s = size
        f = ImageFont.truetype(path, s)
        for _ in range(8):
            w = f.getlength(probe) or f.getlength("A")
            if not w or abs(w - target) < 0.5:
                break
            s2 = max(6, round(s * target / w))
            if s2 == s:
                break
            s = s2
            f = ImageFont.truetype(path, s)
        return s

    def pick(self, ch):
        if ch in self.cache:
            return self.cache[ch]
        cp = ord(ch)
        kind = "primary"
        for cand in ("primary", "cjk", "emoji"):
            for cm in self.chains[cand]:
                if cp in cm:
                    kind = cand
                    break
            else:
                continue
            break
        self.cache[ch] = kind
        return kind

    def face(self, ch, style):
        kind = self.pick(ch)
        return self.faces.get((kind, style)) or self.faces[("primary", style)]

    def one_cell(self, ch, style):
        key = (ch, style)
        w = self.width.get(key)
        if w is None:
            w = self.width[key] = self.face(ch, style).getlength(ch)
        return abs(w - self.cell) < 0.01

    def ascent(self, ch, style=""):
        return self.face(ch, style).getmetrics()[0]


class Screen(pyte.Screen):
    """pyte 0.8.x is stricter than the escape codes herdr emits; ignore replies."""

    def report_device_status(self, *a, **k):
        pass

    def report_device_attributes(self, *a, **k):
        pass

    def report_terminal_parameters(self, *a, **k):
        pass

    def write_process_input(self, *a, **k):
        pass

    def set_mode(self, *a, **k):
        try:
            return super().set_mode(*a, **k)
        except TypeError:
            return None

    def reset_mode(self, *a, **k):
        try:
            return super().reset_mode(*a, **k)
        except TypeError:
            return None

    def set_margins(self, *a, **k):
        try:
            return super().set_margins(*a, **k)
        except TypeError:
            return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cast")
    ap.add_argument("outdir")
    ap.add_argument("--fps", type=float, default=4.0)
    ap.add_argument("--font", default=os.path.expanduser(
        "~/.local/share/fonts/JetBrainsMonoNLNerdFontMono-Regular.ttf"))
    ap.add_argument("--size", type=int, default=14)
    ap.add_argument("--cjk-font", default=os.path.expanduser(
        "~/.local/share/fonts/NotoSansCJKsc-Regular.otf"))
    ap.add_argument("--emoji-font", default=os.path.expanduser(
        "~/.local/share/fonts/noto-emoji-v65-emoji-regular.ttf"))
    ap.add_argument("--theme", default="catppuccin")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--speed", type=float, default=1.0, help="playback speed multiplier")
    ap.add_argument("--max-hold", type=float, default=0.0, help="clamp long static holds (seconds)")
    a = ap.parse_args()

    theme = THEMES[a.theme]
    fg0, bg0 = theme[0], theme[1]

    with open(a.cast, encoding="utf-8") as f:
        header = json.loads(f.readline())
        events = [json.loads(line) for line in f if line.strip()]
    cols, rows = header["width"], header["height"]

    screen = Screen(cols, rows)
    stream = pyte.Stream(screen)
    fonts = Fallback(a.font, a.size, a.cjk_font, a.emoji_font)
    cw = fonts.faces[("primary", "")].getlength("M")
    asc, desc = fonts.faces[("primary", "")].getmetrics()
    ch = asc + desc
    W, H = int(cw * cols * a.scale), int(ch * rows * a.scale)
    os.makedirs(a.outdir, exist_ok=True)
    s = a.scale

    def cell_colors(cell):
        return (resolve(cell.fg, theme, fg0), resolve(cell.bg, theme, bg0),
                cell.bold, cell.italics, cell.reverse)

    def draw_frame(idx):
        img = Image.new("RGB", (W, H), bg0)
        d = ImageDraw.Draw(img)
        buf = screen.buffer
        for y in range(rows):
            line = buf[y]
            x = 0
            while x < cols:
                fg, bg, bold, ital, rev = cell_colors(line[x])
                if rev:
                    fg, bg = bg, fg
                j = x + 1
                while j < cols:
                    if cell_colors(line[j]) != cell_colors(line[x]):
                        break
                    j += 1
                if bg != bg0:
                    d.rectangle([x * cw * s, y * ch * s, j * cw * s - 1, (y + 1) * ch * s - 1], fill=bg)
                key = "bolditalic" if (bold and ital) else ("bold" if bold else ("italic" if ital else ""))
                k = x
                while k < j:
                    cell = line[k]
                    char = cell.data
                    if not char or char == " ":
                        k += 1
                        continue
                    if is_wide(char):
                        fnt = fonts.face(char, key)
                        yoff = (asc - fnt.getmetrics()[0]) * s
                        d.text((k * cw * s, y * ch * s + yoff), char, font=fnt, fill=fg)
                        k += 2
                        continue
                    seg, k0 = [], k
                    while k < j and line[k].data not in ("", " ") and not is_wide(line[k].data) \
                            and fonts.face(line[k].data, key) is fonts.face(line[k0].data, key) \
                            and fonts.one_cell(line[k].data, key):
                        seg.append(line[k].data)
                        k += 1
                    if not seg:
                        # icon or odd glyph: place it on its own cell
                        d.text((k * cw * s, y * ch * s), line[k].data,
                               font=fonts.face(line[k].data, key), fill=fg)
                        k += 1
                        continue
                    fnt = fonts.face(seg[0], key)
                    d.text((k0 * cw * s, y * ch * s), "".join(seg), font=fnt, fill=fg)
                x = j
        cx, cy = screen.cursor.x, screen.cursor.y
        if 0 <= cx < cols and 0 <= cy < rows:
            d.rectangle([cx * cw * s, cy * ch * s, (cx + 1) * cw * s - 1, (cy + 1) * ch * s - 1], outline=fg0)
        img.save(os.path.join(a.outdir, f"f{idx:05d}.png"))

    total = max(e[0] for e in events) + 1.0
    ei = 0
    idx = 0
    prev = None
    timeline = []
    t = 0.0
    while t <= total:
        while ei < len(events) and events[ei][0] <= t:
            if events[ei][1] == "o":
                stream.feed(events[ei][2])
            ei += 1
        snap = (tuple(screen.display), screen.cursor.x, screen.cursor.y)
        if snap != prev:
            draw_frame(idx)
            timeline.append((idx, t))
            idx += 1
            prev = snap
        t += 1.0 / a.fps

    lines = []
    for k, (fi, ts) in enumerate(timeline):
        nxt = timeline[k + 1][1] if k + 1 < len(timeline) else total
        dur = max(0.02, (nxt - ts) / a.speed)
        if a.max_hold and dur > a.max_hold:
            dur = a.max_hold
        lines.append(f"file 'f{fi:05d}.png'")
        lines.append(f"duration {dur:.3f}")
    lines.append(f"file 'f{timeline[-1][0]:05d}.png'")
    with open(os.path.join(a.outdir, "frames.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"frames={len(timeline)} size={W}x{H} grid={cols}x{rows} cell={cw:.1f}x{ch}")


if __name__ == "__main__":
    main()
