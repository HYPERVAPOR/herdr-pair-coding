#!/usr/bin/env python3
"""Keep the watchdog's top-view mirror fresh without sending anything.

Runs the demo copy of herdr-watchdog in dry mode (no messages, no interrupts)
every HB_FEED_INTERVAL seconds, or immediately when the trigger file is touched.
The process stays alive, so `top` sees a live daemon.
"""
import importlib.machinery
import importlib.util
import os
import sys
import time

PATH = os.environ.get("HB_TOOL", "/tmp/gifdemo/herdr-watchdog-demo")
TRIGGER = os.environ.get("HB_TRIGGER", "/tmp/gifdemo/refresh")
INTERVAL = float(os.environ.get("HB_FEED_INTERVAL", "3"))
BIN = os.environ.get("HERDR_BIN") or "herdr"

loader = importlib.machinery.SourceFileLoader("wd", PATH)
spec = importlib.util.spec_from_loader("wd", loader)
wd = importlib.util.module_from_spec(spec)
os.environ.setdefault("HB_DIR", "/tmp/gifdemo/hb")
loader.exec_module(wd)

last = 0.0
while True:
    now = time.time()
    trig = os.stat(TRIGGER).st_mtime if os.path.exists(TRIGGER) else 0.0
    if now - last >= INTERVAL or trig > last:
        try:
            wd.one_pass(BIN, dry=True, all_sessions=False)
        except Exception as e:  # never die: top would lose its daemon
            print("feeder: %r" % (e,), file=sys.stderr, flush=True)
        last = time.time()
    time.sleep(0.2)
