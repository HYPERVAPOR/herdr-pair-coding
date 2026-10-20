#!/usr/bin/env bash
# Rebuild the throwaway repo the demo workers edit (/tmp/gifdemo/work by default).
set -euo pipefail

WORK=${1:-/tmp/gifdemo/work}
rm -rf "$WORK"
mkdir -p "$WORK/mathkit" "$WORK/tests"

cat >"$WORK/README.md" <<'EOF'
# mathkit

Tiny numeric helpers used by the ingest pipeline.
EOF

cat >"$WORK/mathkit/__init__.py" <<'EOF'
"""Small numeric helpers."""

__all__ = ["clamp"]


def clamp(value, lo, hi):
    """Keep `value` inside [lo, hi]."""
    raise NotImplementedError
EOF

cat >"$WORK/tests/test_clamp.py" <<'EOF'
import unittest

from mathkit import clamp


class ClampTest(unittest.TestCase):
    def test_inside_is_unchanged(self):
        self.assertEqual(clamp(5, 0, 10), 5)

    def test_below_is_lifted(self):
        self.assertEqual(clamp(-3, 0, 10), 0)

    def test_above_is_capped(self):
        self.assertEqual(clamp(42, 0, 10), 10)

    def test_floats(self):
        self.assertEqual(clamp(0.52, 0.0, 0.5), 0.5)


if __name__ == "__main__":
    unittest.main()
EOF

printf '__pycache__/\n' >"$WORK/.gitignore"

git -C "$WORK" init -q
git -C "$WORK" add -A
git -C "$WORK" -c user.email=demo@example.com -c user.name=demo \
	commit -qm "mathkit: clamp stub + tests"
echo "demo repo: $WORK ($(git -C "$WORK" rev-parse --short HEAD))"
