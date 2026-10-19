// @ts-nocheck
/**
 * refs-reclaim - safely reclaim git worktrees, local branches and remote
 * branches (tool + /reclaim command).
 *
 * Mounted only on a master profile: reclaiming is the master's job (report
 * based); worker and reviewer do not need it.
 * Classification and execution live entirely in refs-reclaim/refs-reclaim (the
 * single implementation); this file only forwards.
 * Three stages: plan (read-only classification) -> archive (bundle + verify +
 * file archive) -> apply (re-check, then delete).
 *
 * Safety: apply requires the model to pass confirm=true, the CLI requires
 * --yes, and the archive manifest must be verified, the bundle sha256 must
 * match the manifest, and the bundle must pass verify. Before each action the
 * baseline sha, every object's tip, usage and MR state are re-checked. If any
 * check cannot be resolved, nothing is deleted (fail-closed).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

// Same directory as this extension (refs-reclaim/ in this repo), so the CLI is
// found no matter where the extension is loaded from.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "refs-reclaim");

const DESCRIPTION = `Safely reclaim git worktrees, local branches and remote branches (criteria matrix + archive + execution). Three stages; do not skip steps:
- action=plan (read-only): fetch --prune + snapshot + classify. Produces plan.json/plan.md and returns a compact list. Results: T1 = safe to delete; T2 = archive first, then delete (content not in dev, or untracked files outside the whitelist); PROTECTED/MANUAL/PRUNE/BLOCKED = do not delete. Detached worktrees are always MANUAL (hand to a human).
- action=archive: lossless archive. git bundle create --all + verify + copy untracked files outside the whitelist + sha256 manifest. Pass the plan path (plan or archive picks the newest).
- action=apply: actually delete. Requires plan + archive_manifest + confirm=true. Processes worktrees -> local branches -> remote branches, re-checking each before deleting. worktree remove is called without --force; remote branch deletion uses an expected-sha lease.
Typical flow: plan -> report T1/T2 to a human -> approval -> archive -> apply.
Notes: apply changes the repository and the remote. Do not call it before showing the list to a human and getting approval. Most space comes from removing worktrees (reproducible directories such as .venv go with them).`;

function runCli(args, timeout) {
  try {
    return execFileSync(CLI, args, {
      encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],   // inherited stderr lands in pi's result strip
    });
  } catch (e) {
    // First line only: pi echoes the last tool result in a one-line strip.
    const msg = (`${e.stdout || ""}${e.stderr || ""}`.trim() || e.message).split("\n")[0].trim();
    throw new Error(msg.length > 76 ? msg.slice(0, 75) + "…" : msg);
  }
}

const refsReclaim = {
  name: "refs_reclaim",
  label: "Reclaim refs",
  description: DESCRIPTION,
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("plan"), Type.Literal("archive"), Type.Literal("apply")],
      { description: "plan = read-only classification; archive = archive; apply = delete (requires confirm)" },
    ),
    repo: Type.Optional(
      Type.String({ description: "Repository/main worktree directory; defaults to cwd" }),
    ),
    plan: Type.Optional(
      Type.String({ description: "plan-*.json path from the plan stage (for archive/apply)" }),
    ),
    archive_manifest: Type.Optional(
      Type.String({ description: "archive-*.json path from the archive stage (for apply)" }),
    ),
    idle_hours: Type.Optional(
      Type.Number({ description: "plan: how quiet counts as idle (default 2 hours)" }),
    ),
    extra_base: Type.Optional(
      Type.Array(Type.String(), { description: "plan: extra accepted destination branches (e.g. preprod); default is dev only" }),
    ),
    only: Type.Optional(
      Type.Array(
        Type.Union([Type.Literal("worktrees"), Type.Literal("branches"), Type.Literal("remote-branches")]),
        { description: "apply: which kinds to process; default is all three" },
      ),
    ),
    authors: Type.Optional(
      Type.Array(Type.String(), {
        description: "author substrings (name or email) that may be reclaimed; any other author makes a branch MANUAL (gate AU). Omit = author is not a criterion",
      }),
    ),
    allow_unmerged: Type.Optional(
      Type.Boolean({ description: "apply: allow deleting T2 (content not in dev, archive only)" }),
    ),
    include_manual: Type.Optional(
      Type.Array(Type.String(), {
        description: "apply: also remove MANUAL worktrees by name (or '*' for all), after the in-use/quiet/clean gates that a detached row never gets from plan",
      }),
    ),
    confirm: Type.Optional(
      Type.Boolean({ description: "apply: must be true (human approved)" }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const repo = params.repo || (ctx && ctx.cwd) || process.cwd();
    const base = ["--repo", repo];
    if (params.authors && params.authors.length) base.push("--authors", params.authors.join(","));
    let args;
    if (params.action === "plan") {
      args = ["plan", ...base, "--summary-only"];
      if (params.idle_hours != null) args.push("--idle-hours", String(params.idle_hours));
      for (const b of params.extra_base || []) args.push("--extra-base", b);
      return { content: [{ type: "text", text: runCli(args, 300000).trim() }], details: undefined };
    }
    if (!params.plan) throw new Error("refs_reclaim: run action=plan first (needs a plan-*.json)");
    if (params.action === "archive") {
      args = ["archive", ...base, "--plan", params.plan, "--yes"];
      return { content: [{ type: "text", text: runCli(args, 900000).trim() }], details: undefined };
    }
    if (params.confirm !== true) {
      throw new Error("refs_reclaim: apply needs a human approval, then confirm=true");
    }
    if (!params.archive_manifest) throw new Error("refs_reclaim: run action=archive first (needs archive-*.json)");
    args = ["apply", ...base, "--plan", params.plan,
      "--archive-manifest", params.archive_manifest, "--yes"];
    for (const o of params.only || []) args.push("--only", o);
    if (params.allow_unmerged) args.push("--allow-unmerged-branch");
    for (const m of params.include_manual || []) args.push("--include-manual", m);
    return { content: [{ type: "text", text: runCli(args, 600000).trim() }], details: undefined };
  },
};

export default function (pi) {
  pi.registerTool(refsReclaim);

  pi.registerCommand("reclaim", {
    description: "Run one read-only refs-reclaim plan against the current cwd and print the summary",
    handler: async (args, ctx) => {
      try {
        const repo = args.trim() || ctx.cwd;
        const out = runCli(["plan", "--repo", repo, "--summary-only"], 300000).trim();
        ctx.ui.notify("refs-reclaim plan finished (read-only)", "info");
        pi.sendMessage({ role: "assistant", content: [{ type: "text", text: out }] });
      } catch (e) {
        ctx.ui.notify(`refs-reclaim failed: ${e.message.split("\n")[0]}`, "error");
      }
    },
  });
}
