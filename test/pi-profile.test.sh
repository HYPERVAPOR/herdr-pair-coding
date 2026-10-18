#!/usr/bin/env bash
# Self-check for bin/pi-profile: the role comes from the pane label, and an
# explicit role that disagrees with the label is refused.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home/.pi/agent/profiles"
fail=0

check() {  # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1   expected [$2] got [$3]"; fail=1; fi
}

cat > "$T/bin/pi" <<'EOF'
#!/bin/sh
echo "pi $*"
EOF
printf 'PROFILE=(--picked-reviewer)\nexport PI_ROLE=reviewer\n' > "$T/home/.pi/agent/profiles/reviewer.conf"
printf 'PROFILE=(--picked-worker)\nexport PI_ROLE=worker\n' > "$T/home/.pi/agent/profiles/worker.conf"
chmod +x "$T/bin/pi"

label() {
  cat > "$T/bin/herdr" <<EOF
#!/bin/sh
echo '{"result":{"pane":{"label":"$1"}}}'
EOF
  chmod +x "$T/bin/herdr"
}

inside() { HOME="$T/home" PATH="$T/bin:$PATH" HERDR_ENV=1 HERDR_PANE_ID=w1:p1 ./bin/pi-profile "$@"; }
outside() { env -u HERDR_ENV -u HERDR_PANE_ID HOME="$T/home" PATH="$T/bin:$PATH" ./bin/pi-profile "$@"; }

label reviewer
check "no argument takes the label" "pi -ne -ns -np --no-mcp --picked-reviewer" "$(inside)"
check "matching explicit role is allowed" "pi -ne -ns -np --no-mcp --picked-reviewer" "$(inside reviewer)"
inside worker >/dev/null 2>"$T/err"
check "wrong explicit role exits 2" "2" "$?"
check "wrong explicit role says why" "1" "$(grep -c 'refusing to start' "$T/err")"

label worker
check "worker label picks worker" "pi -ne -ns -np --no-mcp --picked-worker" "$(inside)"
check "flags go to pi, role still comes from the label" "pi -ne -ns -np --no-mcp --picked-worker --help" "$(inside --help)"

label "api-reviewer"
check "label substring matches" "pi -ne -ns -np --no-mcp --picked-reviewer" "$(inside)"

label "worker-reviewer"
inside >/dev/null 2>&1
check "ambiguous label exits 2" "2" "$?"

# labels.conf: exact label -> arbitrary profile name (what a host with custom
# profiles uses, e.g. tiiny-worker). It wins over the worker/reviewer guess.
printf '# comment\n\napi = my-worker\n' > "$T/home/.pi/agent/profiles/labels.conf"
printf 'PROFILE=(--picked-custom)\n' > "$T/home/.pi/agent/profiles/my-worker.conf"
label api
check "labels.conf maps a custom label to a profile" "pi -ne -ns -np --no-mcp --picked-custom" "$(inside)"
inside worker >/dev/null 2>&1
check "a role that disagrees with the mapped label is refused" "2" "$?"

check "outside herdr an explicit role still works" "pi -ne -ns -np --no-mcp --picked-worker" "$(outside worker)"
outside >/dev/null 2>&1
check "outside herdr with no role exits 2" "2" "$?"

echo "================ $([ $fail -eq 0 ] && echo 'all passed' || echo 'failed') ================"
exit $fail
