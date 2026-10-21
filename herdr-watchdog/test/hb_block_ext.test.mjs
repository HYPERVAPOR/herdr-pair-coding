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

const tuiStub = { requestRender: () => {} };
const widget = calls.widgets[0].factory(tuiStub, theme);
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
