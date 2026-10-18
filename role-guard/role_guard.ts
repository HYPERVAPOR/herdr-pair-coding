// @ts-nocheck
/**
 * Role guard: the pane label is the role. If the loaded profile disagrees
 * (wrong profile, or bare pi with no profile), say so loudly instead of
 * letting the pair run with mismatched tools and prompts.
 *
 * The label is what the watchdog and last_answer already use to find a pair;
 * PI_ROLE is exported by the profile conf, so it is the second source. This
 * extension is the only place that compares them.
 */
import { execFileSync } from "node:child_process";

function paneLabel() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return null;
  try {
    const out = execFileSync(process.env.HERDR_BIN_PATH || "herdr",
      ["pane", "get", process.env.HERDR_PANE_ID], { encoding: "utf8", timeout: 5000 });
    const m = out.match(/"label"\s*:\s*"([^"]*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function wantedRole(label) {
  const w = label.includes("worker");
  const r = label.includes("reviewer");
  return w === r ? null : w ? "worker" : "reviewer";
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const label = paneLabel();
    const want = label ? wantedRole(label) : null;
    if (!want) return;                       // not a pair pane: nothing to check
    const got = process.env.PI_ROLE || "";
    if (got === want) {
      try { ctx.ui?.setStatus("role", undefined); } catch {}
      return;
    }
    const msg = `Wrong profile in this pane: label "${label}" means ${want}, `
      + (got ? `but the ${got} profile is loaded.` : "but no role profile is loaded (bare pi).")
      + ` Restart with: pi-profile ${want}`;
    try {
      ctx.ui?.notify(msg, "error");
      ctx.ui?.setStatus("role", `⚠ ${got || "bare"} in ${want} pane`);
    } catch {}
  });
}
