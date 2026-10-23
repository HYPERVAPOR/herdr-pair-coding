// @ts-nocheck
// The shared status row: one widget key, several plugins, one line.
//
// Covers herdr-watchdog/status-row.ts on its own (registry, join/leave, column
// routing with the real HStack + MouseRegion) and hb_block's use of it (join on
// session_start, leave on shutdown, fallback to its own widget).
//
// No click in hb_block's own column is simulated here: that would write the real
// heartbeat flag through the CLI. The one click test goes through a stub part.
//
// Run: node herdr-watchdog/test/status-row.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const base = path.join(os.homedir(), ".pi/agent/install/releases");
const PI_ROOT = path.join(base, fs.readdirSync(base).sort().pop(), "node_modules");
const require = createRequire(path.join(PI_ROOT, "noop.js"));
const { createJiti } = require("jiti");
const TUI_PATH = path.join(PI_ROOT, "@earendil-works/pi-tui/dist/index.js");
const TYPEBOX = path.join(PI_ROOT, "typebox/build/index.mjs");
const jiti = createJiti(import.meta.url, {
  alias: { typebox: TYPEBOX, "@earendil-works/pi-tui": TUI_PATH },
});
const TUI = await import(TUI_PATH);

let fail = 0;
const check = (n, c, extra = "") => {
  console.log((c ? "PASS  " : "FAIL  ") + n + (!c && extra ? "   <- " + String(extra).slice(0, 300) : ""));
  if (!c) fail++;
};

// The flag CLI is only ever pointed at a throwaway directory.
const hbDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-row-"));
process.env.HB_DIR = hbDir;
process.env.HERDR_PANE_ID = "w1:p1";
process.env.HERDR_SESSION = "test-session";
process.env.HERDR_TAB_ID = "test-tab";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROW_TS = path.resolve(HERE, "..", "status-row.ts");
const HB_TS = path.resolve(HERE, "..", "hb_block.ts");
const flag = () => fs.existsSync(path.join(hbDir, "flag.json"))
  ? String(JSON.parse(fs.readFileSync(path.join(hbDir, "flag.json"), "utf8")).blocked)
  : "false";

const S = await jiti.import(ROW_TS);
check("the contract exports what pi-utils exports", ["ROW_KEY", "joinStatusRow", "leaveStatusRow", "statusRowAvailable"].every((k) => k in S), Object.keys(S).join(","));
check("both sides use the same widget key", S.ROW_KEY === "status-row", S.ROW_KEY);

const GLOBAL_KEY = "__piStatusRow";
const reset = () => delete globalThis[GLOBAL_KEY];
const theme = { fg: (_colour, text) => text };
/** HStack marks segment boundaries with resets; only the visible text matters. */
const plain = (line) => line.replace(/\x1B\[[0-9;]*m/g, "").replace(/\x1B\]8;;\x07/g, "").trimEnd();
const tuiStub = () => ({ renders: 0, requestRender() { this.renders++; } });
const fakeUi = () => {
  const calls = [];
  return { calls, setWidget: (key, content) => void calls.push({ key, content }) };
};
/** A part that renders a fixed label, optionally wrapped in a real MouseRegion. */
const stubPart = (label, hits, columns) => () => {
  const face = { render: () => [label.padEnd(columns ?? label.length)], invalidate() {} };
  return new TUI.MouseRegion(face, (event) => {
    if (event.type === "press" && event.button === "left") return { handled: true };
    if (event.type === "click" && event.button === "left") {
      hits.push(`${label}@${event.x}`);
      return { handled: true };
    }
    return undefined;
  });
};

// --- 1. one widget, join order, middle leave, last leave ------------------
{
  reset();
  const ui = fakeUi();
  const hits = [];
  const t = tuiStub();
  S.joinStatusRow(ui, "hb_block", stubPart("hb_block:true", hits), TUI);
  check("the first join sets the widget once", ui.calls.length === 1 && ui.calls[0].key === "status-row", JSON.stringify(ui.calls.map((c) => c.key)));
  const row = ui.calls[0].content(t, theme);
  check("rendering asks for no repaint", t.renders === 0, String(t.renders));

  S.joinStatusRow(ui, "cerberus", stubPart("cerberus:capture", hits), TUI);
  check("a second join does not re-set the widget", ui.calls.length === 1, String(ui.calls.length));
  check("it repaints through the remembered tui", t.renders === 1, String(t.renders));
  check("parts render in join order", plain(row.render(120)[0]) === "hb_block:true  cerberus:capture", JSON.stringify(row.render(120).map(plain)));

  S.joinStatusRow(ui, "third", stubPart("third", hits), TUI);
  S.leaveStatusRow(ui, "cerberus");
  check("a middle leave keeps the others without re-setting", ui.calls.length === 1, String(ui.calls.length));
  check("the middle part is gone", plain(row.render(120)[0]) === "hb_block:true  third", JSON.stringify(row.render(120).map(plain)));

  S.leaveStatusRow(ui, "hb_block");
  S.leaveStatusRow(ui, "third");
  check("the last leave clears the row once", ui.calls.length === 2 && ui.calls[1].key === "status-row" && ui.calls[1].content === undefined, JSON.stringify(ui.calls.map((c) => c.key)));
  S.leaveStatusRow(ui, "third");
  S.leaveStatusRow(ui, "never-joined");
  check("repeated and unknown leaves are no-ops", ui.calls.length === 2, String(ui.calls.length));
  check("the registry is dropped, so a reload starts clean", globalThis[GLOBAL_KEY] === undefined, JSON.stringify(globalThis[GLOBAL_KEY]));
}

// --- 2. clicks route by column, not by row --------------------------------
{
  reset();
  const ui = fakeUi();
  const hits = [];
  S.joinStatusRow(ui, "left", stubPart("0123456789abc", hits, 13), TUI);      // 13 columns
  S.joinStatusRow(ui, "right", stubPart("0123456789abcdef", hits, 16), TUI);  // 16 columns
  const row = ui.calls[0].content(tuiStub(), theme);
  const line = plain(row.render(80)[0]);
  check("the two parts share one line", line.startsWith("0123456789abc  0123456789abcdef"), JSON.stringify(line));
  check("exactly two columns of gap", line.slice(13, 15) === "  " && line[15] === "0", JSON.stringify(line.slice(10, 18)));

  const click = (x) => ({ type: "click", button: "left", clickCount: 2, x, y: 0, width: 80, height: 1, screenX: x, screenY: 0, shift: false, alt: false, ctrl: false });
  row.handleMouse(click(12));
  check("x=12 goes to the left part", hits.at(-1) === "0123456789abc@12", JSON.stringify(hits));
  row.handleMouse(click(13));
  row.handleMouse(click(14));
  check("x=13 and x=14 are the gap: nobody's", hits.length === 1, JSON.stringify(hits));
  row.handleMouse(click(15));
  check("x=15 goes to the right part", hits.at(-1) === "0123456789abcdef@0", JSON.stringify(hits));
  check("and with a relative x of 0", hits.at(-1).endsWith("@0"), JSON.stringify(hits.at(-1)));
  row.handleMouse(click(190));
  check("x=190 reaches neither part", hits.length === 2, JSON.stringify(hits));
  S.leaveStatusRow(ui, "left");
  S.leaveStatusRow(ui, "right");
}

// --- the gap is exactly two columns, only between parts ------------------
// The same three labels are asserted in pi-utils' copy, so the two implementations
// are pinned to the same composed line.
{
  reset();
  const ui = fakeUi();
  const label = (text) => () => ({ render: () => [text], invalidate() {} });
  for (const [id, text] of [["a", "aaa"], ["b", "bbb"], ["c", "ccc"]]) {
    S.joinStatusRow(ui, id, label(text), TUI);
  }
  const row = ui.calls[0].content(tuiStub(), theme);
  check("three parts, two spaces between each", plain(row.render(200)[0]) === "aaa  bbb  ccc", JSON.stringify(plain(row.render(200)[0])));

  S.leaveStatusRow(ui, "b");
  S.leaveStatusRow(ui, "c");
  check("a lone part gets no padding", plain(row.render(200)[0]) === "aaa", JSON.stringify(plain(row.render(200)[0])));
  S.leaveStatusRow(ui, "a");
}

// --- 3. an existing registry is reused, not replaced ----------------------
{
  const ui = fakeUi();
  const theirs = { render: () => ({ render: () => ["theirs"], invalidate() {} }) };
  globalThis[GLOBAL_KEY] = {
    version: 1,
    // A peer that is already on this composition: nothing to upgrade, nothing to set.
    renderVersion: 2,
    parts: new Map([["cerberus", () => ({ render: () => ["cerberus:on"], invalidate() {} })]]),
    widgetSet: true,
    render: theirs.render,
  };
  const parts = globalThis[GLOBAL_KEY].parts;
  S.joinStatusRow(ui, "hb_block", stubPart("hb_block:false", []), TUI);
  check("no second setWidget for a current registry someone else owns", ui.calls.length === 0, JSON.stringify(ui.calls.map((c) => c.key)));
  check("their render is untouched", globalThis[GLOBAL_KEY].render === theirs.render);
  check("their part is kept and ours is added", [...parts.keys()].join(",") === "cerberus,hb_block", [...parts.keys()].join(","));
  S.leaveStatusRow(ui, "hb_block");
  S.leaveStatusRow(ui, "cerberus");
  check("the last leave still clears the shared widget", ui.calls.at(-1)?.key === "status-row" && ui.calls.at(-1)?.content === undefined, JSON.stringify(ui.calls.map((c) => c.key)));
}

// --- a registry left over by an older build is upgraded, not trusted -----
// `/reload` rebuilds the extension but `globalThis.__piStatusRow` - and the render the
// widget holds - are the old build's. Before this, the new gap code never ran.
{
  reset();
  const ui = fakeUi();
  const hits = [];
  const staleRender = () => ({ render: () => ["hb_block:truecerberus:on"], invalidate() {} });
  const parts = new Map([["cerberus", stubPart("cerberus:on", hits)]]);
  globalThis[GLOBAL_KEY] = { version: 1, parts, widgetSet: true, render: staleRender };

  S.joinStatusRow(ui, "hb_block", stubPart("hb_block:true", hits), TUI);
  const row = globalThis[GLOBAL_KEY];
  check("the widget is re-set so it drops the old render", ui.calls.length === 1 && ui.calls[0].key === "status-row", JSON.stringify(ui.calls.map((c) => c.key)));
  check("with the new render", ui.calls[0]?.content === row.render);
  check("the registry field itself was replaced", row.render !== staleRender);
  check("and says which composition it has", row.renderVersion === 2, String(row.renderVersion));
  check("the shape version is untouched", row.version === 1, String(row.version));
  check("the foreign part is kept", [...row.parts.keys()].join(",") === "cerberus,hb_block", [...row.parts.keys()].join(","));

  const upgraded = ui.calls[0].content(tuiStub(), theme);
  check("the gap is in effect", plain(upgraded.render(200)[0]) === "cerberus:on  hb_block:true", JSON.stringify(plain(upgraded.render(200)[0])));

  S.joinStatusRow(ui, "third", stubPart("third", hits), TUI);
  check("no further setWidget once the composition is current", ui.calls.length === 1, String(ui.calls.length));
  S.leaveStatusRow(ui, "cerberus");
  S.leaveStatusRow(ui, "hb_block");
  S.leaveStatusRow(ui, "third");
  check("leaving empties it out completely", globalThis[GLOBAL_KEY] === undefined);
}

// --- the reload path: nothing left behind means the new code builds it ---
{
  reset();
  const ui = fakeUi();
  const hits = [];
  S.joinStatusRow(ui, "a", stubPart("aaa", hits), TUI);
  S.joinStatusRow(ui, "b", stubPart("bbb", hits), TUI);
  const before = ui.calls[0].content(tuiStub(), theme);
  check("two parts, one line with the gap", plain(before.render(200)[0]) === "aaa  bbb", JSON.stringify(plain(before.render(200)[0])));
  S.leaveStatusRow(ui, "a");
  S.leaveStatusRow(ui, "b");
  check("the registry does not outlive its last part", globalThis[GLOBAL_KEY] === undefined);

  // A reload: the next join builds a fresh registry with the current composition.
  ui.calls.length = 0;
  S.joinStatusRow(ui, "a", stubPart("aaa", hits), TUI);
  S.joinStatusRow(ui, "b", stubPart("bbb", hits), TUI);
  const after = ui.calls[0].content(tuiStub(), theme);
  check("the gap survives the restart", plain(after.render(200)[0]) === "aaa  bbb", JSON.stringify(plain(after.render(200)[0])));
  check("the fresh registry is current", globalThis[GLOBAL_KEY].renderVersion === 2, String(globalThis[GLOBAL_KEY].renderVersion));
  S.leaveStatusRow(ui, "a");
  S.leaveStatusRow(ui, "b");
}

// --- 4. no HStack: refuse, and create nothing ----------------------------
{
  reset();
  check("an api without HStack reports the row unavailable", S.statusRowAvailable({}) === false);
  const ui = fakeUi();
  let threw = null;
  try {
    S.joinStatusRow(ui, "hb_block", stubPart("hb_block:false", []), {});
  } catch (e) {
    threw = e;
  }
  check("joining then throws", threw !== null && /no HStack/.test(threw.message), threw && threw.message);
  check("and nothing is written or registered", ui.calls.length === 0 && globalThis[GLOBAL_KEY] === undefined);
}

// --- 5. hb_block joins, then leaves --------------------------------------
const mountHb = async (instance = jiti) => {
  const mod = await instance.import(HB_TS, { default: true });
  const state = { handlers: {}, widgets: [], notes: [] };
  const ui = {
    theme,
    setWidget: (key, factory) => state.widgets.push({ key, factory }),
    notify: (msg) => state.notes.push(msg),
  };
  mod({
    registerTool: () => {},
    on: (name, fn) => {
      state.handlers[name] = fn;
    },
    registerCommand: () => {},
  });
  return { state, ui, mod };
};

{
  reset();
  const { state, ui } = await mountHb();
  await state.handlers.session_start({}, { hasUI: true, ui });
  check("hb_block joins the row instead of taking a line", state.widgets.length === 1 && state.widgets[0].key === "status-row", JSON.stringify(state.widgets.map((w) => w.key)));
  const row = globalThis[GLOBAL_KEY];
  check("the registry holds it", [...row.parts.keys()].join(",") === "hb_block", [...row.parts.keys()].join(","));
  const line = plain(row.render(tuiStub(), theme).render(80)[0]);
  check("the line shows the indicator", line.startsWith("hb_block:"), JSON.stringify(line));

  state.handlers.session_shutdown();
  check("shutdown removes the part and the registry", globalThis[GLOBAL_KEY] === undefined, JSON.stringify(globalThis[GLOBAL_KEY]?.parts ? [...globalThis[GLOBAL_KEY].parts.keys()] : null));
  check("and clears the shared widget exactly once", state.widgets.at(-1).key === "status-row" && state.widgets.at(-1).factory === undefined, JSON.stringify(state.widgets.map((w) => w.key)));
  const before = state.widgets.length;
  state.handlers.session_shutdown();
  check("a second shutdown is harmless", state.widgets.length === before, String(state.widgets.length - before));
}

// --- 6. no HStack in pi-tui: hb_block falls back to its own line ----------
{
  reset();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-hstack-"));
  const stub = path.join(stubDir, "pi-tui-no-hstack.mjs");
  // An older pi-tui: the pieces hb_block itself needs, and no HStack.
  fs.writeFileSync(stub, `export { MouseRegion } from ${JSON.stringify(TUI_PATH)};\n`);
  const oldJiti = createJiti(import.meta.url, { moduleCache: false, alias: { typebox: TYPEBOX, "@earendil-works/pi-tui": stub } });
  const { state, ui } = await mountHb(oldJiti);
  await state.handlers.session_start({}, { hasUI: true, ui });
  check("without HStack the indicator keeps its own widget", state.widgets.length === 1 && state.widgets[0].key === "hb_block", JSON.stringify(state.widgets.map((w) => w.key)));
  check("and no row registry was created", globalThis[GLOBAL_KEY] === undefined);
  state.handlers.session_shutdown();
  check("shutdown clears that widget", state.widgets.at(-1).key === "hb_block" && state.widgets.at(-1).factory === undefined, JSON.stringify(state.widgets.map((w) => w.key)));
  fs.rmSync(stubDir, { recursive: true, force: true });
}

// --- 7. both plugins on one line, and the click goes to the right part ----
{
  reset();
  const ui = fakeUi();
  const cerberusHits = [];
  // pi-utils joins first, as it does in a session where cerberus starts earlier.
  S.joinStatusRow(ui, "cerberus", stubPart("cerberus:capture", cerberusHits, 16), TUI);
  const { state } = await mountHb();
  const hbUi = {
    theme,
    setWidget: (key, factory) => ui.setWidget(key, factory),
    notify: () => {},
  };
  await state.handlers.session_start({}, { hasUI: true, ui: hbUi });
  check("still exactly one setWidget for both plugins", ui.calls.length === 1, String(ui.calls.length));

  const row = ui.calls[0].content(tuiStub(), theme);
  const line = plain(row.render(120)[0]);
  check("one line, both labels, join order", /^cerberus:capture\s*hb_block:/.test(line), JSON.stringify(line));

  const click = (x) => ({ type: "click", button: "left", clickCount: 2, x, y: 0, width: 120, height: 1, screenX: x, screenY: 0, shift: false, alt: false, ctrl: false });
  row.handleMouse(click(3));
  check("a click in the cerberus column reaches cerberus", cerberusHits.length === 1 && cerberusHits[0] === "cerberus:capture@3", JSON.stringify(cerberusHits));
  check("and does not reach hb_block (the flag is untouched)", flag() === "false", flag());
  state.handlers.session_shutdown();
  check("hb_block's leave keeps cerberus on the line", [...globalThis[GLOBAL_KEY].parts.keys()].join(",") === "cerberus", [...globalThis[GLOBAL_KEY].parts.keys()].join(","));
  check("and does not clear the widget", ui.calls.length === 1, String(ui.calls.length));
  S.leaveStatusRow(ui, "cerberus");
  check("the last part out clears it", ui.calls.at(-1).content === undefined, JSON.stringify(ui.calls.map((c) => c.key)));
}

reset();
fs.rmSync(hbDir, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
