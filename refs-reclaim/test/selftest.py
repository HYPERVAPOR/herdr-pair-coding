#!/usr/bin/env python3
"""refs-reclaim self-test: runs entirely on scratch repositories in a temp directory; never
touches a real repository, worktree or remote.

Covers:
  A. plan classification: T1 / T2 (untracked files outside the whitelist) / BLOCKED (not in dev,
     checked out by a worktree) / MANUAL (detached) / PROTECTED (main worktree, dev); both W4
     gates (occupied and quiet)
  B. fail-closed: herdr unreachable -> appliable=false; apply without --yes -> refused; bundle
     modified -> refused; appliable=false -> apply refused
  C. archive: bundle verify passes + manifest verified + per-file sha256 match
  D. apply: T2 worktree archived, cleared, then removed; BLOCKED/MANUAL untouched; local/remote
     branches deleted per T1/T2 with a lease; recovery from the bundle; the second plan turns a
     branch that was occupied by a worktree into T1
  E. units: whitelist segment matching (core/__pycache__/ reproducible), dedupe_paths, verify_archived
  F. author gate (AU): a fully merged branch authored by someone outside --authors is MANUAL in
     plan and survives apply, while our own branches are still deleted

Run: python3 test/selftest.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
WD = os.path.dirname(HERE)
CLI = os.path.join(WD, "refs-reclaim")
FAKE_DIR = HERE
FAKE = os.path.join(HERE, "fake-herdr")

fails = []


def check(name, cond, extra=""):
    print("%s  %s%s" % ("PASS" if cond else "FAIL", name,
                        ("   <- " + str(extra).replace("\n", " | ")[:300]) if (not cond and extra) else ""))
    if not cond:
        fails.append(name)


def load_cli():
    loader = importlib.machinery.SourceFileLoader("refs_reclaim", CLI)
    spec = importlib.util.spec_from_loader("refs_reclaim", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def env_with_fake(panes=""):
    e = dict(os.environ)
    if panes:
        e["FAKE_HERDR_CWD"] = panes
    else:
        e.pop("FAKE_HERDR_CWD", None)
    return e


def run_cli(args, env=None, expect_ok=True):
    # Always point tests at the fake herdr explicitly, so they do not depend on real pane state.
    if args and args[0] in ("plan", "archive", "apply") and "--herdr-bin" not in args:
        args = [args[0], "--herdr-bin", FAKE] + args[1:]
    p = subprocess.run([sys.executable, CLI] + args, capture_output=True, text=True,
                       env=env or env_with_fake())
    if expect_ok and p.returncode != 0:
        raise AssertionError("CLI failed: %s\n%s\n%s" % (args, p.stdout, p.stderr))
    return p


def git(*args, cwd):
    p = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError("git %s failed: %s" % (args, p.stderr))
    return p.stdout


def make_scratch(root):
    """bare origin + seed (repo with commits) + clone + 4 worktrees + assorted branches."""
    origin = os.path.join(root, "origin.git")
    subprocess.run(["git", "init", "-q", "--bare", origin], check=True)
    subprocess.run(["git", "-C", origin, "symbolic-ref", "HEAD", "refs/heads/dev"], check=True)

    seed = os.path.join(root, "seed")
    os.makedirs(seed)
    git("init", "-q", cwd=seed)
    git("config", "user.email", "a@b.c", cwd=seed)
    git("config", "user.name", "t", cwd=seed)
    open(os.path.join(seed, "f.txt"), "w").write("base\n")
    open(os.path.join(seed, ".gitignore"), "w").write("__pycache__/\n*.pyc\n.venv/\n")
    os.makedirs(os.path.join(seed, "core"))
    open(os.path.join(seed, "core", "mod.py"), "w").write("x = 1\n")
    git("add", ".", cwd=seed)
    git("commit", "-qm", "base", cwd=seed)
    git("branch", "-M", "dev", cwd=seed)
    git("remote", "add", "origin", origin, cwd=seed)
    git("push", "-q", "origin", "dev", cwd=seed)

    git("checkout", "-qb", "feat/merged", cwd=seed)
    open(os.path.join(seed, "f.txt"), "a").write("merged\n")
    git("commit", "-qam", "feat merged", cwd=seed)
    git("checkout", "-q", "dev", cwd=seed)
    git("merge", "-q", "--no-ff", "feat/merged", "-m", "merge feat/merged", cwd=seed)

    git("checkout", "-qb", "feat/unmerged", cwd=seed)
    open(os.path.join(seed, "f.txt"), "a").write("unmerged\n")
    git("commit", "-qam", "unmerged work", cwd=seed)
    git("checkout", "-q", "dev", cwd=seed)
    # feat/foreign: merged content, but authored by someone else -> gate AU must hold it back
    git("checkout", "-qb", "feat/foreign", "dev", cwd=seed)
    open(os.path.join(seed, "f.txt"), "a").write("foreign\n")
    git("-c", "user.name=someone else", "-c", "user.email=s@x.y",
        "commit", "-qam", "foreign work", cwd=seed)
    git("checkout", "-q", "dev", cwd=seed)
    git("merge", "-q", "--no-ff", "feat/foreign", "-m", "merge feat/foreign", cwd=seed)
    git("push", "-q", "origin", "dev", "feat/merged", "feat/unmerged", "feat/foreign", cwd=seed)

    repo = os.path.join(root, "repo")
    subprocess.run(["git", "clone", "-q", origin, repo], check=True)
    git("config", "user.email", "a@b.c", cwd=repo)
    git("config", "user.name", "t", cwd=repo)
    git("fetch", "-q", "origin", "--prune", cwd=repo)

    # wt-merged: merged branch + untracked file outside the whitelist (T2, archive first)
    wt_merged = os.path.join(root, "wt-merged")
    git("worktree", "add", "-q", wt_merged, "feat/merged", cwd=repo)
    open(os.path.join(wt_merged, "evidence.md"), "w").write("evidence\n")
    # wt-clean: merged branch + nested __pycache__ (reproducible, still T1)
    wt_clean = os.path.join(root, "wt-clean")
    git("worktree", "add", "-q", "-b", "chore/clean", wt_clean, "dev", cwd=repo)
    os.makedirs(os.path.join(wt_clean, "core", "__pycache__"))
    open(os.path.join(wt_clean, "core", "__pycache__", "x.pyc"), "w").write("x")
    # wt-unmerged: unmerged branch (BLOCKED)
    wt_unmerged = os.path.join(root, "wt-unmerged")
    git("worktree", "add", "-q", wt_unmerged, "feat/unmerged", cwd=repo)
    # wt-detached (MANUAL)
    wt_detached = os.path.join(root, "wt-detached")
    git("worktree", "add", "-q", "--detach", wt_detached, "dev", cwd=repo)
    # local-only branch not occupied by any worktree (T1: tip already in dev)
    git("branch", "review/local-only", "dev", cwd=repo)
    # local branch whose tip was authored by someone else (gate AU)
    git("branch", "feat/foreign", "origin/feat/foreign", cwd=repo)

    return {"root": root, "repo": repo, "wt_merged": wt_merged, "wt_clean": wt_clean,
            "wt_unmerged": wt_unmerged, "wt_detached": wt_detached,
            "archive": os.path.join(root, ".archive")}


def plan_json(s, extra=None, tag=""):
    args = ["plan", "--repo", s["repo"], "--no-mr", "--herdr-bin", FAKE,
            "--outdir", s["archive"],
            "--md", os.path.join(s["root"], "plan%s.md" % tag),
            "--json", os.path.join(s["root"], "plan%s.json" % tag)]
    args += extra if extra is not None else ["--ignore-idle"]
    run_cli(args)
    return json.load(open(os.path.join(s["root"], "plan%s.json" % tag)))


def verdict(plan, kind, name):
    for r in plan[kind]:
        if r["name"] == name:
            return r
    return None


# --------------------------------------------------------------------------- #
def main():
    root = tempfile.mkdtemp(prefix="rr-selftest-")
    try:
        s = make_scratch(root)
        repo = s["repo"]

        # ---------------- A. plan classification ----------------
        plan = plan_json(s)
        check("A1 appliable=true (fake herdr works)", plan["appliable"] is True, plan["checks"])
        check("A2 wt-merged = T2 (untracked files outside the whitelist)",
              (verdict(plan, "worktrees", "wt-merged") or {}).get("verdict") == "T2",
              verdict(plan, "worktrees", "wt-merged"))
        check("A3 wt-merged lists evidence.md",
              "evidence.md" in (verdict(plan, "worktrees", "wt-merged") or {}).get("files_outside_whitelist", []))
        check("A4 wt-clean = T1 (nested __pycache__ is reproducible)",
              (verdict(plan, "worktrees", "wt-clean") or {}).get("verdict") == "T1",
              verdict(plan, "worktrees", "wt-clean"))
        check("A5 wt-unmerged = BLOCKED (W2 not in dev)",
              (verdict(plan, "worktrees", "wt-unmerged") or {}).get("verdict") == "BLOCKED")
        check("A6 wt-detached = MANUAL",
              (verdict(plan, "worktrees", "wt-detached") or {}).get("verdict") == "MANUAL")
        check("A7 main worktree = PROTECTED",
              (verdict(plan, "worktrees", "repo") or {}).get("verdict") == "PROTECTED")
        check("A8 local branch review/local-only = T1",
              (verdict(plan, "local_branches", "review/local-only") or {}).get("verdict") == "T1")
        check("A9 local branch feat/unmerged = BLOCKED (checked out by a worktree)",
              (verdict(plan, "local_branches", "feat/unmerged") or {}).get("verdict") == "BLOCKED")
        check("A10 remote feat/merged = T1", (verdict(plan, "remote_branches", "feat/merged") or {}).get("verdict") == "T1")
        check("A11 remote feat/unmerged = T2", (verdict(plan, "remote_branches", "feat/unmerged") or {}).get("verdict") == "T2")
        check("A12 remote dev = PROTECTED", (verdict(plan, "remote_branches", "dev") or {}).get("verdict") == "PROTECTED")

        # A13/A14: both W4 gates (occupied + quiet)
        plan_occ = plan_json(s, extra=["--ignore-idle"])
        # Rerun, but let the fake herdr pin a pane to wt-clean.
        run_cli(["plan", "--repo", repo, "--no-mr", "--herdr-bin", FAKE, "--ignore-idle",
                 "--outdir", s["archive"],
                 "--json", os.path.join(root, "plan-occ.json"),
                 "--md", os.path.join(root, "plan-occ.md")],
                env=env_with_fake(s["wt_clean"]))
        plan_occ = json.load(open(os.path.join(root, "plan-occ.json")))
        r = verdict(plan_occ, "worktrees", "wt-clean") or {}
        check("A13 pane cwd points at wt-clean -> BLOCKED (W4 occupied)",
              r.get("verdict") == "BLOCKED" and any("pane/cwd" in x for x in r.get("occupancy", [])), r)
        fresh = plan_json(s, extra=[], tag="-fresh")  # default --idle-hours 2, files just created -> W4 blocks all
        r2 = verdict(fresh, "worktrees", "wt-clean") or {}
        check("A14 just modified (<2h) -> BLOCKED (W4 quiet)",
              r2.get("verdict") == "BLOCKED" and any("activity within" in x for x in r2.get("reasons", [])), r2)

        # ---------------- B. fail-closed ----------------
        p = run_cli(["plan", "--repo", repo, "--no-mr", "--herdr-bin", "/nonexistent-herdr",
                     "--ignore-idle",
                     "--json", os.path.join(root, "plan-nh.json"),
                     "--md", os.path.join(root, "plan-nh.md")], env=dict(os.environ))
        plan_nh = json.load(open(os.path.join(root, "plan-nh.json")))
        check("B1 herdr unreachable -> appliable=false", plan_nh["appliable"] is False, plan_nh["checks"])

        p = run_cli(["apply", "--repo", repo, "--plan", os.path.join(root, "plan.json"),
                     "--archive-manifest", "/nonexistent.json"], expect_ok=False)
        check("B2 apply without --yes -> refused",
              p.returncode != 0 and "--yes" in (p.stdout + p.stderr), p.stdout + p.stderr)

        # ---------------- C. archive ----------------
        p = run_cli(["archive", "--repo", repo, "--plan", os.path.join(root, "plan.json"),
                     "--outdir", s["archive"], "--yes"])
        manifest_path = [l.split(": ", 1)[1] for l in p.stdout.splitlines() if l.startswith("[P3] manifest:")][0]
        man = json.load(open(manifest_path))
        check("C1 manifest.verified=true", man["verified"] is True, man.get("bundle"))
        check("C2 bundle contains all refs (>3)", man["bundle"]["refs"] > 3, man["bundle"]["refs"])
        pv = subprocess.run(["git", "-C", repo, "bundle", "verify", man["bundle"]["path"]],
                            capture_output=True, text=True)
        check("C3 git bundle verify passes", pv.returncode == 0, pv.stderr)
        copied = {f["from"]: f["sha256"] for f in man["files"]}
        src = os.path.join(s["wt_merged"], "evidence.md")
        import hashlib
        got = hashlib.sha256(open(src, "rb").read()).hexdigest()
        check("C4 evidence.md archived with matching sha256", copied.get(src) == got, copied)

        # B3: bundle modified -> apply refuses
        with open(man["bundle"]["path"], "ab") as fh:
            fh.write(b"x")
        p = run_cli(["apply", "--repo", repo, "--plan", os.path.join(root, "plan.json"),
                     "--archive-manifest", manifest_path, "--yes"], expect_ok=False)
        check("B3 bundle modified (sha256 mismatch) -> apply refused",
              p.returncode != 0 and "sha256" in (p.stdout + p.stderr), p.stdout + p.stderr)
        # Restore by archiving again into a clean bundle
        p = run_cli(["archive", "--repo", repo, "--plan", os.path.join(root, "plan.json"),
                     "--outdir", s["archive"], "--bundle-name", "clean.bundle", "--yes"])
        manifest_path = [l.split(": ", 1)[1] for l in p.stdout.splitlines() if l.startswith("[P3] manifest:")][0]
        man = json.load(open(manifest_path))

        p = run_cli(["apply", "--repo", repo, "--plan", os.path.join(root, "plan-nh.json"),
                     "--archive-manifest", manifest_path, "--yes"], expect_ok=False)
        check("B4 appliable=false -> apply refused",
              p.returncode != 0 and "appliable" in (p.stdout + p.stderr), p.stdout + p.stderr)

        # ---------------- D. apply ----------------
        p = run_cli(["apply", "--repo", repo, "--plan", os.path.join(root, "plan.json"),
                     "--archive-manifest", manifest_path, "--allow-unmerged-branch", "--yes"])
        log_path = [l.split(": ", 1)[1] for l in p.stdout.splitlines() if l.startswith("[P7] log")][0].strip()
        apply_log = json.load(open(log_path))
        check("D1 apply has no failures", not apply_log["failed"], apply_log["failed"])
        check("D2 T2 worktree archived and evidence.md cleared",
              not os.path.exists(os.path.join(s["wt_merged"], "evidence.md")))
        check("D3 wt-merged removed", not os.path.exists(s["wt_merged"]))
        check("D4 wt-unmerged (BLOCKED) untouched", os.path.exists(s["wt_unmerged"]))
        check("D5 wt-detached (MANUAL) untouched", os.path.exists(s["wt_detached"]))
        check("D6 local branch review/local-only deleted",
              "review/local-only" not in git("branch", cwd=repo))
        remote = git("ls-remote", "--heads", "origin", cwd=repo)
        check("D7 remote feat/merged deleted", "refs/heads/feat/merged" not in remote, remote)
        check("D8 remote feat/unmerged deleted", "refs/heads/feat/unmerged" not in remote, remote)
        check("D9 remote dev still present", "refs/heads/dev" in remote)
        # Archive recovery
        git("fetch", "-q", man["bundle"]["path"], "refs/heads/feat/unmerged:refs/heads/recovery/unmerged", cwd=repo)
        check("D10 deleted branch recoverable from the bundle",
              git("log", "--oneline", "-1", "recovery/unmerged", cwd=repo).strip().endswith("unmerged work"))
        # Two-round behavior: wt-merged is gone -> its branch becomes T1
        plan2 = plan_json(s)
        check("D11 second plan: feat/merged becomes T1 (was occupied by a worktree)",
              (verdict(plan2, "local_branches", "feat/merged") or {}).get("verdict") == "T1",
              verdict(plan2, "local_branches", "feat/merged"))

        # ---------------- F. author gate (AU) ----------------
        root2 = tempfile.mkdtemp(prefix="rr-selftest-author-")
        try:
            s2 = make_scratch(root2)
            planA = plan_json(s2, extra=["--ignore-idle", "--authors", "t <a@b.c>"], tag="-auth")
            ra = verdict(planA, "local_branches", "feat/foreign") or {}
            check("F1 foreign author -> MANUAL (gate AU)",
                  ra.get("verdict") == "MANUAL" and any(x.startswith("AU no") for x in ra.get("reasons", [])), ra)
            check("F2 plan records authors", ra.get("authors") == ["someone else <s@x.y>"], ra.get("authors"))
            rm = verdict(planA, "remote_branches", "feat/foreign") or {}
            check("F3 remote with a foreign author -> MANUAL", rm.get("verdict") == "MANUAL", rm)
            check("F4 our own branch is still T1",
                  (verdict(planA, "local_branches", "review/local-only") or {}).get("verdict") == "T1",
                  verdict(planA, "local_branches", "review/local-only"))
            pa = run_cli(["archive", "--repo", s2["repo"], "--outdir", s2["archive"], "--yes",
                          "--plan", os.path.join(s2["root"], "plan-auth.json")])
            mpath = [l.split(": ", 1)[1] for l in pa.stdout.splitlines() if l.startswith("[P3] manifest:")][0]
            run_cli(["apply", "--repo", s2["repo"], "--allow-unmerged-branch", "--yes",
                     "--plan", os.path.join(s2["root"], "plan-auth.json"),
                     "--archive-manifest", mpath, "--authors", "t <a@b.c>"])
            check("F5 apply leaves the foreign local branch alone",
                  "feat/foreign" in git("branch", cwd=s2["repo"]), git("branch", cwd=s2["repo"]))
            remote2 = git("ls-remote", "--heads", "origin", cwd=s2["repo"])
            check("F6 apply leaves the foreign remote branch alone",
                  "refs/heads/feat/foreign" in remote2, remote2)
            check("F7 apply still deletes our own branch",
                  "review/local-only" not in git("branch", cwd=s2["repo"]), git("branch", cwd=s2["repo"]))
        finally:
            shutil.rmtree(root2, ignore_errors=True)

        # ---------------- E. units ----------------
        m = load_cli()
        wl = m.DEFAULT_WHITELIST
        check("E1 nested __pycache__ is reproducible", m.matches_whitelist("core/__pycache__/", wl))
        check("E2 core itself is not reproducible", not m.matches_whitelist("core/", wl))
        check("E3 evidence.md is not whitelisted", not m.matches_whitelist("qa-readonly/evidence.md", wl))
        check("E4 dedupe drops entries covered by a parent",
              m.dedupe_paths(["repro/", "repro/x.py", "other/"]) == ["other/", "repro/"])
        tmpd = os.path.join(root, "verify-arch")
        os.makedirs(tmpd)
        fp = os.path.join(tmpd, "a.txt")
        open(fp, "w").write("hello")
        mf = {"files": [{"from": fp, "to": fp + ".copy", "sha256": m.sha256_file(fp)}]}
        check("E5 verify_archived matches", m.verify_archived(mf, fp) is True)
        open(fp, "a").write("tampered")
        check("E6 verify_archived detects modification", m.verify_archived(mf, fp) is False)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print()
    if fails:
        print("FAILED: %d\n  - %s" % (len(fails), "\n  - ".join(fails)))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
