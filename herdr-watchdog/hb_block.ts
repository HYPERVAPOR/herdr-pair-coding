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
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

// Same directory as this extension (herdr-watchdog/ in this repo), so the CLI
// is found no matter where the extension is loaded from.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "herdr-watchdog");

// Footer indicator: whether this pair is currently blocked (true = watchdog
// muted). Only this tool writes the value, so the indicator and the flag have
// the same source. Value first, so a narrow terminal does not truncate it.
// shortcut: the value is read on session_start and after each block/unblock,
// not by a timer. Editing the flag file by hand is only picked up on the next
// refresh or /reload.
const ANIM_MS = 800;
let ui = null;
let blocked = false;
let tick = 0;
let timer = null;

function render() {
  if (!ui) return;
  ui.setStatus("hb_block", blocked
    ? ui.theme.fg("warning", "hb_block:true 😴 " + "z".repeat(tick + 1))
    : ui.theme.fg("dim", "hb_block:false 👂 " + ")".repeat(tick + 1)));
}

function refreshStatus() {
  if (!ui) return;
  let cur;
  try {
    cur = execFileSync("python3", [CLI, "get"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return;   // If the read fails, keep the old value rather than show a fake false.
  }
  blocked = cur === "true";
  tick = 0;
  render();
  if (!timer) timer = setInterval(() => { tick = (tick + 1) % 4; render(); }, ANIM_MS);
}

const DESCRIPTION = `Block or restore the heartbeat watchdog for "you and the worker next to you". Call it only at two moments, never continuously:
- action=block: (1) you are starting a long task (e2e, several minutes) that the watchdog would misread as stuck; (2) you are talking to a human; (3) you finished this round or are waiting for a decision. reason is one sentence (max 120 chars) saying what you are waiting for; longer values are truncated, not rejected.
- action=unblock: back to pair coding with the worker.

After block, the watchdog stops disturbing this pair. Forgetting to unblock mutes the pair permanently; nothing flips it back for you. Unblock as soon as the long task finishes, the conversation ends, or the decision is made. A repeated call with the same value is a safe no-op.`;

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : null;
    refreshStatus();
  });

  pi.on("session_shutdown", () => {   // session switch / reload / exit all converge here; idempotent
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
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
        const out = execFileSync(
          "python3",
          [CLI, "set", "--action=" + params.action, "--reason=" + params.reason],
          { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
        );
        refreshStatus();   // the flag may have flipped; update the footer immediately
        return { content: [{ type: "text", text: out.trim() }], details: undefined };
      } catch (e) {
        // Rejections (reason too long, file not locatable) must reach the model
        // verbatim, but as one line: pi echoes the last tool result in a one-line
        // strip under the transcript.
        const msg = (`${e.stdout || ""}${e.stderr || ""}`.trim() || e.message).split("\n")[0].trim();
        throw new Error(msg.length > 76 ? msg.slice(0, 75) + "…" : msg);
      }
    },
  });
}
