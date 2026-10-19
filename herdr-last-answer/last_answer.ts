// @ts-nocheck
/**
 * last_answer - read the answer body from another pane (the tool shell around
 * the herdr-last-answer/herdr-last-answer script).
 *
 * Why wrap it in a tool: `herdr-last-answer` is a standalone script on PATH, not a
 * herdr subcommand. When the model was asked to assemble the command itself,
 * surrounded by `herdr ...` calls, it produced `herdr agent herdr-last-answer` (herdr
 * just returned its subcommand list without an error), wasting turns. As a
 * tool, the model calls it by name and this shell assembles argv, so that class
 * of mistake disappears structurally.
 *
 * Mounted on the reviewer and master profiles (the name must be listed in the
 * --tools whitelist). The implementation (fetch + render) is always the script.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const DESCRIPTION = `Read the answer body from **another pane** (no TUI footer, no pane-width truncation). This is the canonical way to read answers.
- The \`herdr-last-answer <target>\` in your rules is this tool. It is a standalone script on PATH, **not a herdr subcommand** (do not write \`herdr agent herdr-last-answer\`).
- target is a pane id (e.g. \`wE:p1M\`) or an agent name.
- Use n to read the last N answers; use tools=true to summarize which tools were called in the last answer's turn.
- It only reads answers that already happened. If the other side has not spoken or the session file is not persisted yet, it says so explicitly; that is not an error. End the turn instead of treating it as "stuck"; do not call \`herdr agent wait\` or sleep/poll — the watchdog wakes you.
- To look at the screen (crash, error, diagnostics), use \`herdr agent read <target> --source recent-unwrapped\`, not this tool.`;

function resolveCli() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cands = [
    path.join(here, "herdr-last-answer"),   // bundle layout: CLI sits next to this file
    path.join(os.homedir(), ".pi", "agent", "bin", "herdr-last-answer"),
    path.join(here, "..", "bin", "herdr-last-answer"),
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore: try the next candidate */
    }
  }
  throw new Error("last_answer: herdr-last-answer not found — link it into ~/.local/bin or beside the extension");
}

const lastAnswer = {
  name: "last_answer",
  label: "Read answer",
  description: DESCRIPTION,
  parameters: Type.Object({
    target: Type.String({
      description: "Whose answer to read: pane id (e.g. wE:p1M) or agent name",
    }),
    n: Type.Optional(
      Type.Number({ minimum: 1, maximum: 20, description: "Read the last N answers (default 1)" }),
    ),
    tools: Type.Optional(
      Type.Boolean({ description: "Also print a summary of the tools called in the last answer's turn (max 10)" }),
    ),
  }),

  async execute(_toolCallId, params) {
    const cli = resolveCli();
    const args = [params.target];
    if (params.n != null) args.push("--n", String(params.n));
    if (params.tools) args.push("--tools");
    try {
      const out = execFileSync(cli, args, {
        encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        // Capture stderr: inherited stderr is what the user sees smeared into the
        // one-line result strip under pi's transcript.
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { content: [{ type: "text", text: out.trim() || "(empty)" }], details: undefined };
    } catch (e) {
      const detail = `${e.stdout || ""}${e.stderr || ""}`.trim();
      if (e.status === 3) {
        // "has not answered yet" (including "session file not persisted") is not a
        // failure: keep only the first reason line, not the repeated fallback lines.
        const why = (String(detail).split("\n")[0] || "").replace(/^herdr-last-answer:\s*/, "");
        return {
          content: [{
            type: "text",
            text: `${params.target} has no readable answer yet (${why})\n`
              + "-> It has not spoken yet. End this turn; do not run `herdr agent wait` or a retry loop — the watchdog wakes you when it is idle."
              + " To check the screen, use `herdr agent read <target> --source recent-unwrapped`.",
          }],
          details: undefined,
        };
      }
      // pi previews the last tool result on ONE line under the transcript, so keep
      // it inside 76 characters: the CLI's first line already says what failed.
      const line = String(detail || e.message).split("\n")[0].trim();
      throw new Error(line.length > 76 ? line.slice(0, 75) + "…" : line);
    }
  },
};

export default function (pi) {
  pi.registerTool(lastAnswer);
}
