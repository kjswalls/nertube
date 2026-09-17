#!/usr/bin/env bash
# Rebuild a throwaway local database, apply the Supabase shim and every
# migration, then run every supabase/tests/*.test.sql against it.
#
# Usage:  scripts/verify-db.sh [dbname]
# Env:    PGHOST PGPORT PGUSER (default 127.0.0.1 5432 postgres)
#
# This is the Docker-free stand-in for `supabase db reset`. Where the Supabase
# CLI stack is available, prefer that; this harness exists so schema, RLS
# policies and SQL functions can still be exercised for real without Docker.
set -euo pipefail

cd "$(dirname "$0")/.."

DB="${1:-${NERTUBE_TEST_DB:-nertube_test}}"
PSQL=(psql -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" -v ON_ERROR_STOP=1 -q)

echo "== resetting database: $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\" with (force)" -c "create database \"$DB\""

echo "== applying shim"
"${PSQL[@]}" -d "$DB" -f supabase/tests/shim.sql

shopt -s nullglob
for f in supabase/migrations/*.sql; do
  echo "== migration: $f"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

ran=0
for t in supabase/tests/*.test.sql; do
  echo "== test: $t"
  "${PSQL[@]}" -d "$DB" -f "$t"
  ran=$((ran + 1))
done

echo "== OK (migrations applied, $ran test file(s) passed)"
