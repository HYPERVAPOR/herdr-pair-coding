// @ts-nocheck
/**
 * hb_block tool for herdr-watchdog: the reviewer uses it to say "do not
 * disturb this pair right now" (README sections 1/2/4).
 *
 * Mounted only on a reviewer profile; worker and master do not need it.
 * session/tab/pane all come from environment variables (HERDR_SESSION,
 * HERDR_TAB_ID, HERDR_PANE_ID); the model only supplies action + reason.
 * Persistence lives in herdr-watchdog/herdr-watchdog (the single definition of
 * the file format); this file only forwards.
 *
 * Humans get the same switch two other ways, both also through that CLI:
 * double-clicking the indicator widget, and the /hb command.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MouseRegion } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Same directory as this extension (herdr-watchdog/ in this repo), so the CLI
// is found no matter where the extension is loaded from.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "herdr-watchdog");

// Indicator widget: whether this pair is currently blocked (true = watchdog
// muted). Every path (tool, double-click, /hb) goes through `herdr-watchdog
// set`, so the indicator and the flag have the same source. Value first, so a
// narrow terminal does not truncate it.
// shortcut: the value is read on session_start and after each block/unblock,
// not by a timer. Editing the flag file by hand is only picked up on the next
// refresh or /reload.
const ANIM_MS = 800;
const WIDGET_KEY = "hb_block";
// Click and /hb have no human-supplied reason; the CLI rejects an empty one and
// truncates past 120 chars, so these stay short and obvious in the history.
const CLICK_REASON = "manual toggle (double-click)";
const USAGE = "usage: /hb | /hb block <reason> | /hb unblock";
let ui = null;
let tui = null;   // handed to the widget factory; only used to request renders
let blocked = false;
let tick = 0;
let timer = null;

function render() {
  tui?.requestRender();
}

function refreshStatus() {
  let cur;
  try {
    cur = execFileSync("python3", [CLI, "get"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return;   // If the read fails, keep the old value rather than show a fake false.
  }
  blocked = cur === "true";
  tick = 0;
  render();
  // No UI (print/RPC) still needs `blocked` for /hb; the animation is pointless there.
  if (ui && !timer) timer = setInterval(() => { tick = (tick + 1) % 4; render(); }, ANIM_MS);
}

// The one write path. Throws on failure (the CLI exiting non-zero), so callers
// decide whether that is a failed tool result, a notification or a click that
// simply does not flip.
function setFlag(action, reason) {
  return execFileSync(
    "python3",
    [CLI, "set", "--action=" + action, "--reason=" + reason],
    { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function oneLine(e) {
  const msg = (`${e.stdout || ""}${e.stderr || ""}`.trim() || e.message).split("\n")[0].trim();
  return msg.length > 76 ? msg.slice(0, 75) + "…" : msg;
}

// Widget factory: MouseRegion around the one-line indicator. setStatus is
// string-only, so the indicator cannot live in the status row any more.
function indicator(tuiInjected, theme) {
  tui = tuiInjected;
  const face = {
    render: () => [blocked
      ? theme.fg("warning", "hb_block:true 😴 " + "z".repeat(tick + 1))
      : theme.fg("dim", "hb_block:false 👂 " + ")".repeat(tick + 1))],
    invalidate() {},
  };
  const region = new MouseRegion(face, (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;   // right/middle click: ignore
    // A single click does nothing: hb_block is a latch nothing resets, so an
    // accidental click must not mute a pair. Only a double click toggles.
    if ((event.clickCount ?? 1) < 2) return { handled: true };
    try {
      setFlag(blocked ? "unblock" : "block", CLICK_REASON);
    } catch {
      // A click cannot report an error anywhere useful; refreshStatus() below
      // keeps the indicator honest either way.
    }
    refreshStatus();
    return { handled: true };
  });
  return Object.assign(region, {
    dispose() { if (tui === tuiInjected) tui = null; },
  });
}

const DESCRIPTION = `Block or restore the heartbeat watchdog for "you and the worker next to you". Call it only at two moments, never continuously:
- action=block: (1) you are starting a long task (e2e, several minutes) that the watchdog would misread as stuck; (2) you are talking to a human; (3) you finished this round or are waiting for a decision. reason is one sentence (max 120 chars) saying what you are waiting for; longer values are truncated, not rejected.
- action=unblock: back to pair coding with the worker.

After block, the watchdog stops disturbing this pair. Forgetting to unblock mutes the pair permanently; nothing flips it back for you. Unblock as soon as the long task finishes, the conversation ends, or the decision is made. A repeated call with the same value is a safe no-op.`;

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : null;
    if (ui) ui.setWidget(WIDGET_KEY, indicator);   // no mouse events in regular mode; /hb still works
    refreshStatus();
  });

  pi.on("session_shutdown", () => {   // session switch / reload / exit all converge here; idempotent
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (ui) ui.setWidget(WIDGET_KEY, undefined);
    ui = null;
    tui = null;
  });

  // Keyboard path for the same toggle (docs/tui.md: "Design every interaction
  // with a keyboard path even when fullscreen mouse input is available").
  pi.registerCommand("hb", {
    description: "Toggle the heartbeat block (or /hb block <reason>, /hb unblock)",
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (verb && verb !== "block" && verb !== "unblock") {
        ctx.ui?.notify(USAGE, "warning");
        return;
      }
      const action = verb || (blocked ? "unblock" : "block");
      const reason = rest.join(" ").trim() || (verb ? `manual (/hb ${verb})` : "manual toggle (/hb)");
      let line;
      try {
        line = setFlag(action, reason);
      } catch (e) {
        line = oneLine(e);
      }
      refreshStatus();
      ctx.ui?.notify(line, "info");   // one line of confirmation
    },
  });

  pi.registerTool({
    name: "hb_block",
    label: "Block heartbeat",
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("block"), Type.Literal("unblock")], {
        description: "block = do not disturb (long task / talking to a human / waiting for a decision); unblock = back to pair coding",
      }),
      reason: Type.String({
        maxLength: 200,   // loose gate: never reject an action for length (the CLI truncates past 120 chars with "…")
        description: "One sentence (max 120 chars) saying what you are waiting for; shown in history, e.g. \"20-minute e2e\" or \"done\"",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        const out = setFlag(params.action, params.reason);
        refreshStatus();   // the flag may have flipped; update the indicator immediately
        return { content: [{ type: "text", text: out }], details: undefined };
      } catch (e) {
        // Rejections (reason too long, file not locatable) must reach the model
        // verbatim, but as one line: pi echoes the last tool result in a one-line
        // strip under the transcript.
        throw new Error(oneLine(e));
      }
    },
  });
}
