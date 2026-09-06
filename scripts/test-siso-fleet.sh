#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TMPDIR:?Set TMPDIR to the system temporary directory}"
siso_test_dir=$(mktemp -d "${TMPDIR%/}/.siso-ephemeral-fleet-test.XXXXXX")
trap 'node -e '\''require("fs").rmSync(process.argv[1],{recursive:true,force:true})'\'' "$siso_test_dir"' EXIT HUP INT TERM
SISO_TEST_DIR="$siso_test_dir" npx tsx src/fleet.test.ts
SISO_TEST_DIR="$siso_test_dir" npx tsx src/fleet-http.test.ts
python3 -B scripts/siso-node-test.py "$siso_test_dir"
python3 -B scripts/siso-release-test.py "$siso_test_dir"
