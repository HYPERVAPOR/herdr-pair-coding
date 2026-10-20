#!/usr/bin/env python3
"""Record a pty session to an asciinema v2 cast file (no deps beyond stdlib)."""
import argparse
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import re
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=168)
    ap.add_argument("--rows", type=int, default=46)
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=float, default=120.0)
    ap.add_argument("--stop-file", default=None, help="stop when this file appears")
    ap.add_argument("--hold", type=float, default=3.0, help="keep recording this long after --stop-file appears")
    ap.add_argument("--no-reply", action="store_true",
                    help="do not answer terminal capability queries (keeps most TUIs on 256 colors)")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()

    cmd = list(a.cmd)
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        ap.error("no command given")

    winsz = struct.pack("HHHH", a.rows, a.cols, 0, 0)
    start = time.time()
    pid, fd = pty.fork()
    if pid == 0:  # child
        fcntl.ioctl(0, termios.TIOCSWINSZ, winsz)
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("COLORTERM", "truecolor")
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)

    # --- minimal terminal responder -------------------------------------
    # A bare pty answers nothing, so TUIs fall back to a 16/256-color palette.
    # Answer the handful of queries herdr (and most TUIs) use to detect a real
    # terminal: DA1, fg/bg color, color scheme, cell size and DECRQM.
    cell_h, cell_w = 18, 8
    replies = [
        (rb"\x1b\[c", b"\x1b[?62;22c"),
        (rb"\x1b\[>0c", b"\x1b[?62;22c"),
        (rb"\x1b\]10;\?(?:\x1b\\|\x07)", b"\x1b]10;rgb:cdd6/f4f4/f4f4\x1b\\"),
        (rb"\x1b\]11;\?(?:\x1b\\|\x07)", b"\x1b]11;rgb:1e1e/2e2e/2e2e\x1b\\"),
        (rb"\x1b\[\?996n", b"\x1b[?997;1n"),
        (rb"\x1b\[16t", ("\x1b[6;%d;%dt" % (cell_h, cell_w)).encode()),
    ]

    def answer(data: bytes) -> None:
        if a.no_reply:
            return
        out = []
        for pat, rep in replies:
            for _ in re.finditer(pat, data):
                out.append(rep)
        for m in re.finditer(rb"\x1b\[\?(\d+)\$p", data):
            out.append(b"\x1b[?" + m.group(1) + b";2$y")
        for chunk in out:
            try:
                os.write(fd, chunk)
            except OSError:
                pass

    dec = codecs.getincrementaldecoder("utf-8")("replace")
    events = []
    hold_until = None
    while True:
        elapsed = time.time() - start
        if a.stop_file and hold_until is None and os.path.exists(a.stop_file):
            hold_until = elapsed + a.hold
        if hold_until is not None and elapsed >= hold_until:
            break
        if elapsed >= a.duration:
            break
        r, _, _ = select.select([fd], [], [], min(0.05, a.duration - elapsed))
        if not r:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        answer(data)
        text = dec.decode(data)
        if text:
            events.append([round(time.time() - start, 6), "o", text])

    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(pid), sig)
        except ProcessLookupError:
            break
        for _ in range(30):
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
            time.sleep(0.05)

    with open(a.out, "w", encoding="utf-8") as f:
        f.write(json.dumps({
            "version": 2,
            "width": a.cols,
            "height": a.rows,
            "timestamp": int(start),
            "env": {"TERM": "xterm-256color", "COLORTERM": "truecolor"},
        }) + "\n")
        for ev in events:
            f.write(json.dumps(ev) + "\n")
    print(f"cast: {a.out}  events={len(events)}  bytes={sum(len(e[2]) for e in events)}  dur={events[-1][0] if events else 0:.1f}s")


if __name__ == "__main__":
    main()
