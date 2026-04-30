#!/usr/bin/env bash
# Wrapper around `node --test` that:
#   1. Expands the test-file globs in bash (works on node 20+22; node 21+ also
#      expands globs natively but we don't rely on that).
#   2. Forces serial file execution (--test-concurrency=1) — tests share
#      tests/fixtures/vault/ state files, parallel file workers race on them.
#   3. Optionally enables --experimental-test-coverage.
#
# Usage:
#   scripts/run-tests.sh                    # all unit + integration
#   scripts/run-tests.sh test/unit          # one subdir
#   scripts/run-tests.sh --coverage         # all + coverage report

set -e
cd "$(dirname "$0")/.."

COVERAGE=""
SUBDIRS=()
for arg in "$@"; do
  case "$arg" in
    --coverage) COVERAGE="--experimental-test-coverage" ;;
    *) SUBDIRS+=("$arg") ;;
  esac
done

if [ ${#SUBDIRS[@]} -eq 0 ]; then
  SUBDIRS=("test/unit" "test/integration")
fi

# Collect *.test.js under each subdir (sorted so order is deterministic).
# Recursive — test/unit/renderer/*.test.js etc. are picked up automatically.
FILES=()
for d in "${SUBDIRS[@]}"; do
  while IFS= read -r f; do
    FILES+=("$f")
  done < <(find "$d" -name '*.test.js' -type f | sort)
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "no *.test.js files under: ${SUBDIRS[*]}"
  exit 1
fi

exec node $COVERAGE --test --test-concurrency=1 "${FILES[@]}"
