# `scripts/dev-stack` — a local, Docker-free Supabase stand-in

**This is a TEST harness. It approximates Supabase. It is never used in
production, it is never deployed, and the application does not import a single
line of it.** It exists for one reason: this repository is developed and
reviewed in an environment with **no Docker daemon**, so `supabase start` cannot
run, and without it no page that needs data could be opened at all — the app
could be typechecked and built and nothing more.

Where Docker *is* available, `supabase start` / `supabase db reset` is the
authority and this harness should be ignored.

```bash
npm run dev:stack       # reset, seed, serve http://127.0.0.1:54321
npm run dev             # the app, pointed at that origin
npm run e2e             # Playwright: starts the app itself, reuses this stack
npm run e2e:refresh     # the session-refresh spec, on its own ports and database
npm run dev:stack:smoke # drive a running stack with supabase-js
npm run dev:stack:stop  # stop any stack left behind by a SIGKILL
```

`npm run e2e` starts the **application** itself every time (it is the only place
the app is pointed at this harness, so a server it did not start is a server
testing something else) and will reuse a stack you already have up.
`npm run e2e:refresh` takes its own ports *and its own database*
(`nertube_e2e_refresh`), because the whole point of that command is a five-second
access token and a reused stack would still be minting hour-long ones.

## What it actually is

```
              ┌───────────────────── npm run dev:stack ─────────────────────┐
  next dev ──▶│  http://127.0.0.1:54321                                     │
  (the app)   │    /rest/v1/*     ──reverse proxy──▶  postgrest :54322 ──┐   │
              │    /auth/v1/*     ──a GoTrue subset (auth.mts)           │   │
              │    /storage/v1/*  ──a Storage subset (storage.mts)  ─────┤   │
              └─────────────────────────────────────────────────────────┼───┘
                                                                        ▼
                                             PostgreSQL: nertube_dev (real RLS)
```

Two thirds of that picture are the real thing:

- **PostgreSQL** is real. Starting the stack is two resets, not one: the twelve
  SQL test files run against `nertube_test` and have to pass before anything is
  served, and then `nertube_dev` — the database that is actually served — is
  built from `supabase/tests/shim.sql` plus every `supabase/migrations/*.sql`
  and *nothing else* (`scripts/verify-db.sh --no-tests`).
  `supabase/tests/00_fixture.test.sql` deliberately COMMITS two fixture tenants
  and an `fx` schema of security-definer helpers; RLS hides them from the app,
  but a served database that carries rows no migration describes is a database
  every `service_role` read, seed count and future admin query would be lying
  about.
- **PostgREST 12.2.12** is the real binary a hosted project runs. It validates
  the JWT itself, `SET ROLE`s to `anon` or `authenticated` from the token's
  `role` claim, and publishes the claims as `request.jwt.claims` — which is what
  `auth.uid()` reads. Every RLS policy, column grant and `security definer`
  function in `0001_init.sql` is enforced by Postgres, not by JavaScript.
  It logs in as **`authenticator`** (created by `auth-schema.sql`: `login
  noinherit`, granted `anon`, `authenticated` and `service_role` and nothing
  else), exactly as a hosted project does — so a token whose `role` claim says
  `postgres` is refused here with `permission denied to set role "postgres"`
  rather than quietly honoured.

The third is not: GoTrue and the Storage API are re-implemented, in about 1,200
lines, to the shape `@supabase/supabase-js` parses. That is where the
approximating happens, and the list at the bottom of this file says exactly what
is missing.

## Files

| File | What it is |
|---|---|
| `start.mts` | The runner: reset → seed → PostgREST → gateway → wait for Ctrl-C |
| `shared.ts` | Ports, secret, seed identity. Plain `.ts` because `playwright.config.ts` imports it and Playwright's loader cannot evaluate `import.meta` |
| `config.mts` | `shared.ts` re-exported, plus the paths only the running stack needs |
| `server.mts` | The one origin; routes `/rest/v1`, `/auth/v1`, `/storage/v1`, `/health` |
| `rest.mts` | The reverse proxy onto PostgREST |
| `auth.mts` | `/auth/v1/token`, `/user`, `/logout`, `/.well-known/jwks.json`, `/settings` |
| `storage.mts` | Upload, upsert, overwrite, download, remove, list, signed URLs |
| `jwt.ts` | HS256 sign and verify, ~100 lines, no dependency |
| `db.mts` | The harness's own database access, including `withClaims()` |
| `seed.mts` | One user, two channels, a couple of ideas — from `lib/defaults.ts` |
| `auth-schema.sql` | Dev-only columns on `auth.users` and a `refresh_tokens` table |
| `smoke.mts` | `npm run dev:stack:smoke` — drives a running stack with supabase-js |
| `stop.mts` | `npm run dev:stack:stop` — stops stacks from their pid files |

The end-to-end tests live in `e2e/` and are configured by `playwright.config.ts`
at the repository root. `npm run e2e` always starts the application itself and
will reuse a stack that is already up; `npm run e2e:refresh` starts its own
stack, on its own ports and database, with a five-second access token — the only
way to see `proxy.ts`'s refresh actually fire. If that command ever finds a
stack minting longer tokens it fails, rather than skipping the one test it
exists to run.

## Three things it does *not* fake

**The storage ownership rule is the real policy.** Every read and write of
`storage.objects` goes through `withClaims()`, which opens a transaction, sets
`request.jwt.claims` and `SET ROLE`s to the caller's role. So when the harness
answers 403 to an upload at `<someone-else>/x.png`, that 403 is
`0001_init.sql`'s policy —

```sql
(storage.foldername(name))[1] = auth.uid()::text
```

— refusing in Postgres. Change the policy and this surface changes with it. Only
the *bytes* are the harness's own business.

**The board columns read `0` even though ideas were seeded.** That is the app,
not the harness: `app/c/[slug]/board/page.tsx` hard-codes `count={0}` and
renders no cards, because cards are M1. The rows are there — `npm run
dev:stack:smoke` counts them, and so does
`select count(*) from videos` in `nertube_dev`.

**The seed writes the way the app writes.** It calls `create_channel` and
`capture_video` over an `authenticated` connection, not as a superuser with
plain `INSERT`s. A seed that bypassed the grants could produce a database the
app itself could never have created — a video already past the packaging gate,
say — and then every test above it would be testing a fiction.

## Credentials

Everything the stack prints is a fixed test constant, committed on purpose so
`npm run dev:stack` needs no setup:

| | |
|---|---|
| Origin | `http://127.0.0.1:54321` |
| Sign in | `dev@nertube.test` / `nertube-dev-password` |
| JWT secret | the string the Supabase CLI uses for its own local stack |
| anon / service_role keys | JWTs signed with that secret, printed at startup |

They are not secrets. They sign tokens that reach a throwaway database on
127.0.0.1 and nothing else.

| Variable | Default | What it does |
|---|---|---|
| `SEED_EMAIL` / `SEED_PASSWORD` | `dev@nertube.test` / `nertube-dev-password` | The one account |
| `DEV_STACK_PORT` | `54321` | The gateway |
| `DEV_STACK_POSTGREST_PORT` | `54322` | PostgREST |
| `DEV_STACK_HOST` | `127.0.0.1` | The gateway's bind address |
| `DEV_STACK_JWT_SECRET` | the CLI's local constant | Signs every token |
| `DEV_STACK_ACCESS_TOKEN_TTL` | `3600` | Access-token lifetime, 1s–7 days |
| `DEV_STACK_POSTGREST_USER` | `authenticator` | The role PostgREST logs in as |
| `NERTUBE_DEV_DB` | `nertube_dev` | The database that is **served** |
| `NERTUBE_TEST_DB` | `nertube_test` | The database the SQL tests are run in |
| `DEV_STACK_ALLOW_REMOTE_DB` | unset | Lifts the loopback-only check on `PGHOST` |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` | `127.0.0.1`, `5432`, `postgres`, empty | The Postgres server (loopback only) |
| `E2E_PORT` / `E2E_REUSE` | `3111` / unset | Playwright: the app's port, and whether servers may be reused |

**`npm run dev:stack` DROPS AND RECREATES `nertube_dev` and `nertube_test` every
time.** Never point `NERTUBE_DEV_DB` or `NERTUBE_TEST_DB` at a database you care
about.

**It makes no outbound HTTP requests — but it will talk to whatever Postgres
`PGHOST` names.** `PGHOST` and `PGPASSWORD` are exactly the variables you export
to work against a hosted database, and the first thing a start does is `drop
database ... with (force)`. So `shared.ts` and `scripts/verify-db.sh` both refuse
to run unless the host is loopback, and both name the host they refused.
`DEV_STACK_ALLOW_REMOTE_DB=1` lifts that check; there is no good reason to set
it.

## State on disk, and stopping it

Each stack owns `.dev-stack/<database>-<gateway port>/` — its PostgREST config,
its uploaded bytes and a `stack.json` naming its pid. That namespacing is why a
second stack on other ports no longer rewrites the first one's config file or
deletes its objects. Two stacks sharing one *database* is refused outright, and
so is a port clash, each with a message saying which pid is in the way.

`npm run dev:stack` takes PostgREST down with it on Ctrl-C, on a group signal
(which is how Playwright stops it), and on a plain `kill` of the `npm` wrapper —
npm does not forward that signal, so the stack watches its parent instead of
trusting it. (That watch only works because the `dev:stack` script runs `node
--import tsx` directly: the `tsx` *launcher* adds a second node process in
between, and it outlives npm, so the stack's parent never changes and the watch
never fires. Do not put another process layer in that script.) **A `kill -9` is
the one case nothing can catch**: it leaves PostgREST holding its port. `npm run
dev:stack:stop` cleans that up from the pid files.

---

# What this harness does not reproduce

A passing local run is not a passing hosted run. Everything below is a known
difference between this harness and a real Supabase project. **Read it before
trusting a green local run for anything on it** — an undocumented divergence is
how a harness turns into false confidence, so if you find one that is not here,
either fix it or add it.

### Auth (GoTrue)

1. **Only two grants exist**: `password` and `refresh_token`. No magic link, no
   OTP, no OAuth, no SSO, no anonymous sign-in, no `signUp`. Every other
   `/auth/v1` path answers 404 with a message saying so.
2. **No email at all.** No confirmation mail, no password reset, no email-change
   flow. The seeded user is created already confirmed.
3. **No rate limiting and no lockout.** Real GoTrue throttles sign-in attempts
   per IP and per address; here you may guess a password as fast as you like.
4. **No MFA, no identity linking, no user management API.** `auth.admin.*` is
   not implemented — `scripts/seed-demo.ts`, which uses `auth.admin.createUser`,
   still cannot run here.
5. **No `sessions` table and no session revocation semantics.** Refresh tokens
   rotate and the old one is marked revoked, but there is no reuse-detection
   that kills the whole family, no `AAL`, no timebox, no "sign out everywhere".
6. **Refresh token rotation has a reuse interval, but a simplified one.**
   GoTrue's `SECURITY_REFRESH_TOKEN_REUSE_INTERVAL` is reproduced (10 seconds,
   answering a just-rotated token with the session that replaced it) because
   without it a server-rendered page — which builds several Supabase clients per
   request — signs the user out the moment its token expires. What is *not*
   reproduced is what happens outside that window: real GoTrue treats a replayed
   token as a compromise and revokes the whole family; here it is just an
   unknown token. `npm run e2e:refresh` exercises the path end to end.
7. **The JWT is signed with a shared HS256 secret** and is not rotatable. Real
   projects are moving to asymmetric signing keys with a real JWKS;
   `/.well-known/jwks.json` here returns an empty key set, so `getClaims()` will
   not verify locally the way it does against a hosted project.
8. **No `aud` enforcement, no `iss` enforcement, no clock skew tolerance.**
9. **Postgres-side `auth` helpers are the shim's, not Supabase's.** `auth.jwt()`
   does not exist; `auth.uid()`, `auth.role()` and `auth.email()` are
   re-creations in `supabase/tests/shim.sql`. There is no `auth.users` trigger
   machinery, and `auth.users` here has a handful of columns rather than thirty.

### The gateway (Kong)

10. **An api key is required, but that is all that is checked.** The gateway
    refuses a request to `/rest/v1`, `/auth/v1` or `/storage/v1` that carries no
    `apikey` (401 `No API key found in request`) or one that is not signed with
    this stack's secret (401 `Invalid authentication credentials`), the way
    Kong's `key-auth` does. `/health` and the signed-URL GET are exempt. What is
    *not* reproduced: Kong's consumers and ACLs, its rate limiting, its request
    size limits, its exact error bodies, and any per-route plugin behaviour.
11. **An `apikey` with no `Authorization` stays anon here.** The gateway copies
    an *anon* key into `Authorization` and never a `service_role` one, so a bare
    `apikey: <service_role>` cannot become an RLS-bypassing session. Whether a
    hosted project would honour that header is not something this can settle —
    always send both headers, which is what supabase-js does.
12. **CORS is permissive**, echoing whatever origin asks. A real project's Kong
    is not.
13. **No HTTPS.** Everything is plaintext on loopback, so anything that depends
    on secure cookies, `SameSite=None` or a real domain is untested here.

### PostgREST and the database

14. **`db-schemas` is `public` only.** `graphql_public`, `storage` and the
    `auth` schema are not exposed over REST, so `.schema('storage')` fails here
    and would work there.
15. **No connection pooler (Supavisor), no statement timeout, no
    `pg_net`/`pg_cron`/`pgjwt`/`pg_graphql`/`vault`, no Edge Functions, no
    Realtime.** `supabase.channel(...)` does nothing. `pgcrypto` is installed
    because the harness's own password hashing needs it.
16. **No PostgREST pre-request hook, no `role` claim mapping beyond the literal
    claim, and no `db-extra-search-path` tuning.** `db-max-rows` is 1000 to
    match Supabase's default.
17. **The role graph is the shim's.** PostgREST logs in as `authenticator`
    granted `anon`, `authenticated` and `service_role`, which is the shape that
    matters — but those roles and their grants come from
    `supabase/tests/shim.sql`, not from Supabase's own bootstrap, and
    `authenticator` here has no password because the local server is trust-auth.
    `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`,
    `dashboard_user` and `pgbouncer` do not exist.
18. **The database is plain PostgreSQL 16 built by the shim.** The shim is
    close, not identical — see `docs/MILESTONES.md`, "The database harness, and
    its caveat". In particular `storage.objects` here has seven columns, not the
    real table's set, and there is no storage trigger machinery.
19. **The SQL test suite proves `nertube_test`, not `nertube_dev`.** Both are
    built from the same shim and the same migrations in the same run, but the
    tests execute against the throwaway one, because
    `supabase/tests/00_fixture.test.sql` commits fixture rows and a served
    database must contain only what the migrations describe.
20. **Nothing enforces Supabase's platform limits**: no per-project connection
    cap, no request size ceiling, no read-replica routing, no Kong rate limits.

### Storage

21. **No image transformation.** `transform: { width, height }` is ignored, and
    `/render/image/*` is not served.
22. **No resumable (TUS) uploads, no multipart-large-object uploads, no
    `uploadToSignedUrl`, no `move`, no `copy`, no `list-v2`, no `info`.** Those
    answer 501 with a message naming this file.
23. **No public buckets and no bucket management.** `0001_init.sql` creates the
    one private `thumbnails` bucket; the harness will not create, alter or
    delete a bucket. `getPublicUrl()` is meaningless here.
24. **No CDN, no cache headers that mean anything, no ETag revalidation, no
    Range requests.** A download is always the whole object.
25. **Object metadata is a subset.** `size`, `mimetype`, `cacheControl`,
    `lastModified` and `eTag` are recorded; version ids, `owner_id`,
    `path_tokens` and user metadata search are not.
26. **`list()` is one level, but a simplified one.** A prefix with or without a
    trailing slash returns that level: objects by bare name, and everything
    deeper collapsed to one row per folder with `id`, `metadata` and the
    timestamps null — the real API's shape. What is *not* reproduced: the
    `search` option, `sortBy` on anything but `name` (ascending or descending),
    and the real service's SQL-side pagination. `limit`/`offset` are applied
    after collapsing, over a scan capped at 10,000 rows, so a bucket larger than
    that would page differently here.
27. **Storage error bodies are the shape `storage-js` parses, not byte-identical
    to the service's.** An expired or tampered token is 401 `InvalidJWT` (which
    is the distinction that matters: a rejected *token*, not a rejected path); a
    policy refusal is 403; a missing object is 400 with `Object not found`. The
    real service's status codes for some of these have changed across versions.
28. **Bytes live in `.dev-stack/<db>-<port>/storage/`, a gitignored directory
    that is wiped on every `npm run dev:stack`.** There is no durability story.

### Operating the harness itself

29. **`PGHOST` decides which Postgres is dropped and recreated.** There is no
    outbound HTTP anywhere in the harness, but it will talk to whatever Postgres
    it is pointed at, so `shared.ts` and `scripts/verify-db.sh` refuse a
    non-loopback host unless `DEV_STACK_ALLOW_REMOTE_DB=1` says otherwise.
30. **A `kill -9` orphans PostgREST.** Ctrl-C, a group signal and a plain `kill`
    of the `npm` wrapper are all handled (the stack watches its parent, because
    npm does not forward that signal — which is also why the `dev:stack` script
    runs `node --import tsx` rather than the `tsx` launcher: the launcher adds a
    node process that outlives npm and would keep the parent pid stable
    forever). SIGKILL cannot be handled; `npm run dev:stack:stop` clears up
    after it.
31. **`npm run e2e` reuses a stack you already have running.** That is
    deliberate — it is the fast inner loop — but it means the database under the
    suite may carry whatever you did to it by hand. A cold `npm run
    dev:stack:stop && npm run e2e` is the clean run. The *application* server is
    never reused (`E2E_REUSE=1` opts in), because Playwright's `env` block is
    the only thing aiming the app at this origin.
32. **No Studio, no dashboard, no log explorer, no advisors.**
33. **`supabase gen types` still cannot run** (it shells out to Docker even with
    `--db-url`), so `lib/database.types.ts` remains hand-written and this
    harness does nothing to verify it beyond the queries the tests happen to
    make.

If a behaviour matters and is on that list, the only honest way to check it is a
real Supabase project.
