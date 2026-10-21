// hb_block refusals must reach the model as a one-line failed tool result.
// The indicator widget must toggle on a double click only, and /hb must exist.
// HB_DIR points the CLI at a throwaway flag directory (never the live one).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const base = path.join(os.homedir(), ".pi/agent/install/releases");
const PI_ROOT = path.join(base, fs.readdirSync(base).sort().pop(), "node_modules");
const require = createRequire(path.join(PI_ROOT, "noop.js"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    typebox: path.join(PI_ROOT, "typebox/build/index.mjs"),
    "@earendil-works/pi-tui": path.join(PI_ROOT, "@earendil-works/pi-tui/dist/index.js"),
  },
});
const TUI = await import(path.join(PI_ROOT, "@earendil-works/pi-tui/dist/index.js"));
const { TuiAltScreen } = await import(path.join(PI_ROOT, "@earendil-works/pi-tui/dist/tui-alt-screen.js"));

let fail = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS  " : "FAIL  ") + n + (!c && extra ? "   <- " + String(extra).slice(0, 300) : "")); if (!c) fail++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-block-"));
process.env.HB_DIR = tmp;
process.env.HERDR_PANE_ID = "w1:p1";
process.env.HERDR_SESSION = "test-session";
process.env.HERDR_TAB_ID = "test-tab";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.resolve(HERE, "..", "herdr-watchdog");
const flag = () => execFileSync("python3", [CLI, "get"], { encoding: "utf8" }).trim();

// A UI stub that records what the extension asks for, so "it registered a
// widget / a command / said one line" is an assertion instead of a guess.
const calls = { commands: [], handlers: {}, widgets: [], notes: [] };
const theme = { fg: (_colour, text) => text };
const uiStub = {
  theme,
  setStatus: () => check("setStatus is no longer used", false),
  setWidget: (key, factory) => calls.widgets.push({ key, factory }),
  notify: (msg, kind) => calls.notes.push({ msg, kind }),
};

const mod = await jiti.import(path.resolve(HERE, "..", "hb_block.ts"), { default: true });
const tools = [];
mod({
  registerTool: (t) => tools.push(t),
  on: (name, fn) => { calls.handlers[name] = fn; },
  registerCommand: (name, opts) => calls.commands.push({ name, opts }),
});
check("registers one tool", tools.length === 1, String(tools.length));
const t = tools[0] || {};
check("registers the hb command", calls.commands.map((c) => c.name).join(",") === "hb", JSON.stringify(calls.commands.map((c) => c.name)));

const command = calls.commands[0]?.opts?.handler;

// --- the widget: value first, double click toggles, single click does not ---
await calls.handlers.session_start({}, { hasUI: true, ui: uiStub });
check("sets the indicator as a widget", calls.widgets.length === 1 && calls.widgets[0].key === "hb_block", JSON.stringify(calls.widgets.map((w) => w.key)));
const factory = calls.widgets[0].factory;

const tuiStub = { requestRender: () => {} };
const widget = factory(tuiStub, theme);
const line = () => widget.render(80).join("\n");
check("the widget renders the value first", line().startsWith("hb_block:"), JSON.stringify(line()));
const click = (clickCount, button = "left", type = "click") => ({ type, button, clickCount });

// No flag file yet -> false.
check("no flag reads as false", flag() === "false", flag());
widget.handleMouse(click(1));
check("a single click does not block", flag() === "false", flag());
check("the indicator still says false", line().startsWith("hb_block:false"), JSON.stringify(line()));
widget.handleMouse(click(2));
check("a double click blocks", flag() === "true", flag());
check("the indicator follows the double click", line().startsWith("hb_block:true"), JSON.stringify(line()));
widget.handleMouse(click(2));
check("a second double click unblocks", flag() === "false", flag());
widget.handleMouse(click(3));
check("a triple click is ignored, not a second toggle", flag() === "false", flag());
widget.handleMouse({ ...click(2), button: "right" });
check("a right double click is ignored", flag() === "false", flag());
widget.handleMouse({ ...click(2), button: "middle" });
check("a middle double click is ignored", flag() === "false", flag());
widget.handleMouse(click(1, "left", "press"));
check("a press without a click is ignored", flag() === "false", flag());

// --- the slash command: keyboard path for the same switch ---
check("the command is registered with a description", typeof command === "function" && !!calls.commands[0].opts.description);
const run = async (args) => { calls.notes.length = 0; await command(args, { ui: uiStub }); return calls.notes.map((n) => n.msg); };
await run("");
check("/hb toggles on", flag() === "true", flag());
check("/hb says one line", calls.notes.length === 1, JSON.stringify(calls.notes));
check("/hb toggles back off", (await run("")).length === 1 && flag() === "false", flag());
await run("block waiting on the e2e");
check("/hb block writes the block", flag() === "true", flag());
const reason = execFileSync("python3", [CLI, "show"], { encoding: "utf8" });
check("/hb block keeps the human reason", reason.includes("waiting on the e2e"), reason.slice(0, 200));
await run("unblock");
check("/hb unblock restores", flag() === "false", flag());
const notes = await run("nonsense");
check("/hb refuses an unknown verb", notes.length === 1 && notes[0].includes("usage"), JSON.stringify(notes));
check("/hb refusal does not touch the flag", flag() === "false", flag());
check("no confirmation is ever more than one line", calls.notes.every((n) => !n.msg.includes("\n")), JSON.stringify(calls.notes));

// A flag directory that cannot be created: the CLI refuses, the tool must turn
// that into a one-line failed tool result instead of dumping its stderr.
process.env.HB_DIR = "/dev/null/nope";
try {
  await t.execute("c1", { action: "block", reason: "waiting" }, undefined, undefined, {});
  check("an unusable flag dir is a failed tool result", false);
} catch (e) {
  check("an unusable flag dir is a failed tool result", true);
  check("its message is one line", !String(e.message).includes("\n"), JSON.stringify(e.message));
  check("its message is not empty", String(e.message).trim().length > 0, JSON.stringify(e.message));
  check("its message fits an 80-column pane (<=76)", String(e.message).length <= 76, `${String(e.message).length}: ${e.message}`);
}

// Degraded mode: no UI at all. Registering and using /hb must not throw, and
// /hb must still toggle against the real flag (it reads the CLI, not a widget).
calls.widgets.length = 0;
await calls.handlers.session_start({}, { hasUI: false, ui: uiStub });
check("no UI means no widget", calls.widgets.length === 0, JSON.stringify(calls.widgets.map((w) => w.key)));
process.env.HB_DIR = tmp;
let threw = null;
try {
  calls.notes.length = 0;
  await command("block no ui", { ui: undefined });
} catch (e) { threw = e; }
check("/hb works without a UI", threw === null, threw && threw.message);
check("/hb blocked without a UI", flag() === "true", flag());
calls.notes.length = 0;
threw = null;
try { await command("", { ui: undefined }); } catch (e) { threw = e; }
check("/hb toggles back without a UI", threw === null && flag() === "false", flag());

// --- routing through the real TuiAltScreen, not hand-made events ---
// pi-tui only synthesises a click for a component that claimed the preceding
// press, so a handler that ignores presses leaves the feature dead in the real
// app even when the click logic itself is right. This block drives press/release
// pairs through the framework and watches the flag file.
function mount() {
  const term = { columns: 60, rows: 14, write() {}, start() {}, stop() {}, setTitle() {} };
  const tui = new TuiAltScreen(term, false, undefined);
  const seen = [];
  const recorder = new TUI.MouseRegion({ render: () => ["rec:" + seen.at(-1)], invalidate() {} }, (e) => {
    if (e.type === "press" && e.button === "left") return { handled: true };
    if (e.type === "click") seen.push("click" + e.clickCount);
    return { handled: true };
  });
  const indicator = factory(tui, theme);
  const widgets = new TUI.Container();
  widgets.addChild(new TUI.Spacer(1));
  widgets.addChild(indicator);
  widgets.addChild(recorder);
  const editor = { render: () => [" editor ", " ", " "], invalidate() {} };
  const dock = new TUI.VStack([
    { component: widgets, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
  ]);
  const root = new TUI.VStack([
    { component: { render: () => Array(6).fill(" transcript "), invalidate() {} }, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  tui.setLayoutRoot(root);
  tui.altScreenActive = true;
  tui.doRender();
  return {
    tui,
    seen,
    indicator,
    recorder,
    // Screen row of a mounted component: hit-test without side effects (a
    // dispatchMouseToLayout press never becomes a click).
    rowOf: (component) => {
      for (let y = 0; y < 14; y++) {
        const hit = tui.dispatchMouseToLayout({ type: "press", button: "left", x: 2, y, screenX: 2, screenY: y, width: 60, height: 14 });
        if (hit?.target?.component === component) return y;
      }
      return -1;
    },
    pair: (y) => {
      tui.handleMouseEvent({ x: 2, y, button: 0, release: false });
      tui.handleMouseEvent({ x: 2, y, button: 0, release: true });
    },
  };
}

// history length in a throwaway flag dir: one entry per real write.
const entries = (dir) => {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  if (!files.length) return 0;
  return (JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")).history || []).length;
};

await calls.handlers.session_start({}, { hasUI: true, ui: uiStub });
const routeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-route-"));
process.env.HB_DIR = routeDir;

const h = mount();
const yRec = h.rowOf(h.recorder);
h.pair(yRec);
h.pair(yRec);
check("the TUI really synthesises clicks for a claimed press", h.seen.join(",") === "click1,click2", h.seen.join(","));

const yWidget = h.rowOf(h.indicator);
check("the indicator answers a press on its screen row", yWidget >= 0, String(yWidget));
h.pair(yWidget);
check("one press+release does not flip the flag", flag() === "false" && entries(routeDir) === 0, `${flag()} entries=${entries(routeDir)}`);
h.pair(yWidget);
check("two pairs within 500 ms flip it once", flag() === "true" && entries(routeDir) === 1, `${flag()} entries=${entries(routeDir)}`);

const routeDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "hb-route3-"));
process.env.HB_DIR = routeDir3;
const h3 = mount();
const y3 = h3.rowOf(h3.indicator);
h3.pair(y3);
h3.pair(y3);
h3.pair(y3);
check("a third pair adds no second toggle", entries(routeDir3) === 1, `${entries(routeDir3)} entries`);
fs.rmSync(routeDir, { recursive: true, force: true });
fs.rmSync(routeDir3, { recursive: true, force: true });
process.env.HB_DIR = tmp;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
