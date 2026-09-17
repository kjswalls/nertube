#!/usr/bin/env bash
# Rebuild a throwaway local database, apply the Supabase shim and every
# migration, then (unless --no-tests) run every supabase/tests/*.test.sql
# against it.
#
# Usage:  scripts/verify-db.sh [--no-tests] [dbname]
# Env:    PGHOST PGPORT PGUSER (default 127.0.0.1 5432 postgres)
#         DEV_STACK_ALLOW_REMOTE_DB=1 to allow a non-loopback PGHOST
#
# `--no-tests` stops after the migrations. It exists for
# `scripts/dev-stack/start.mts`, which needs a *serving* database: the test
# suite's first file (supabase/tests/00_fixture.test.sql) deliberately COMMITS
# two fixture tenants and an `fx` helper schema, and rows that no migration
# describes have no business being in the database the app is developed against.
# The stack still runs the full suite first, against its own throwaway database.
#
# This is the Docker-free stand-in for `supabase db reset`. Where the Supabase
# CLI stack is available, prefer that; this harness exists so schema, RLS
# policies and SQL functions can still be exercised for real without Docker.
set -euo pipefail

cd "$(dirname "$0")/.."

RUN_TESTS=1
DB=""
for arg in "$@"; do
  case "$arg" in
    --no-tests) RUN_TESTS=0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) DB="$arg" ;;
  esac
done

DB="${DB:-${NERTUBE_TEST_DB:-nertube_test}}"

# This script's first statement is `drop database ... with (force)`. PGHOST is
# exactly the variable a developer exports when working against a hosted
# Postgres, so refuse anything that is not loopback unless told out loud.
HOST="${PGHOST:-127.0.0.1}"
if [ "${DEV_STACK_ALLOW_REMOTE_DB:-}" != "1" ]; then
  case "$HOST" in
    127.*|localhost|::1|'[::1]'|/*) ;;
    *)
      echo "refusing to run: PGHOST is '$HOST', which is not loopback." >&2
      echo "This script DROPS AND RECREATES '$DB'. Set DEV_STACK_ALLOW_REMOTE_DB=1 if you really mean it." >&2
      exit 2
      ;;
  esac
fi

PSQL=(psql -h "$HOST" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" -v ON_ERROR_STOP=1 -q)

echo "== resetting database: $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\" with (force)" -c "create database \"$DB\""

echo "== applying shim"
"${PSQL[@]}" -d "$DB" -f supabase/tests/shim.sql

shopt -s nullglob
for f in supabase/migrations/*.sql; do
  echo "== migration: $f"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

if [ "$RUN_TESTS" -eq 0 ]; then
  echo "== OK (migrations applied, tests skipped: --no-tests)"
  exit 0
fi

ran=0
for t in supabase/tests/*.test.sql; do
  echo "== test: $t"
  "${PSQL[@]}" -d "$DB" -f "$t"
  ran=$((ran + 1))
done

echo "== OK (migrations applied, $ran test file(s) passed)"
