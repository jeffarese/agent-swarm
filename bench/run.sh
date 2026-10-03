#!/bin/sh
# Runs bench/swarm.bench.ts against a mod folder (default: this one) and prints its report.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
mod=$(cd "${1:-$here}" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$mod/.claude-plugin" "$mod/hooks" "$mod/types" "$mod/tsconfig.json" "$work/"
mkdir "$work/tests"
cp "$here/bench/swarm.bench.ts" "$work/tests/bench.test.ts"
claude plugin test "$work" 2>&1 | awk '/Received:/{sub(/^ *Received: "/,""); sub(/"$/,""); gsub(/\\n/,"\n"); gsub(/\\"/,"\""); print; print ""}'
