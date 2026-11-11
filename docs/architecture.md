# Handshake architecture, through the first MVP

- **Status:** Agreed design for the MVP (chat 1 of 3: architecture and design)
- **Created:** 2026-11-03
- **Author:** Claude Code, for Alfred Mah
- **Builds on:** `docs/shared-ledger-spec.md` (what the app does and why), `AGENTS.md` (project rules)
- **Contract:** `docs/api-v1.md` and `docs/api-v1.openapi.yaml` (what Pholio is built against)

How the three documents divide the work: the spec says what each feature does, this document says how the
system is put together and what chats 2 and 3 build, and `docs/api-v1.md` is the HTTP contract. They agree;
if they ever seem not to, the contract wins for API shapes, the spec for product behaviour, and this
document for structure. Fix the other one in the same change.

## 1. Decisions confirmed with the owner (2026-11-03)

| #   | Question                                     | Answer                                                                                                                                                                                                     |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who absorbs the rounding cent?               | **The payer.** Shares round normally to the cent; the payer's own share takes the difference ($10 by 3, Sam paid: Alex 3.33, Jo 3.33, Sam 3.34). With several payers: the biggest payer (assumed default). |
| 2   | Can a guest remove any entry?                | **Only ones they added.**                                                                                                                                                                                  |
| 3   | Who can complete a group?                    | **The owner. There is no admin role.** Everything the spec gave to "owner and admin" is the owner's alone.                                                                                                 |
| 4   | Complete while someone still owes?           | **Yes, after a confirmation naming them.**                                                                                                                                                                 |
| 5   | Which slices are in the MVP (chats 2 and 3)? | **All seven.**                                                                                                                                                                                             |

Removing the admin role changes spec decisions 8, 10 and 11, the mutation list (`member.setRole` is gone)
and the screens. The spec has been updated to match.

**Decisions of 2026-11-04** (architecture review, then the chat and payments design), all recorded in the
spec's decisions 4, 8, 10, 17–20 and in `docs/chat-spec.md`:

| #   | Question                    | Answer                                                                                                                                       |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Who writes locally?         | **One `commit(intent)`**, one transaction (§9.4).                                                                                            |
| 7   | Who may do what?            | **One action matrix** on each side, held in step by a shared case table (ADR-007). Members add people and make invites.                      |
| 8   | When does a payback count?  | **After a handshake**: one side records, the other confirms (ADR-008).                                                                       |
| 9   | Debts?                      | **Between pairs**, visible to everyone; with several payers each payer absorbs their own items' cent (ADR-008).                              |
| 10  | What does Pholio get?       | **Payments that count**, sent and received (ADR-004).                                                                                        |
| 11  | Account deletion?           | **A confirmation dialog**; history keeps the name; allowed with open debts (spec decision 19).                                               |
| 12  | Chat, nudges, live updates? | **Slice 8, after the MVP** (`docs/chat-spec.md`), with Realtime as a change signal only (ADR-009) and a newest-first message feed (ADR-010). |

## 2. System context

```mermaid
flowchart LR
	subgraph devices["People's devices"]
		PWA["Web PWA<br/>browser + service worker"]
		IOS["iOS app<br/>Capacitor, bundles dist/"]
		AND["Android app<br/>Capacitor, bundles dist/"]
	end
	subgraph vercel["Vercel (one project, this repo)"]
		STATIC["Static site<br/>dist/: index.html, assets, sw.js"]
		API["API v1 function<br/>api/v1/[...path].ts, Bun runtime"]
	end
	subgraph supabase["Supabase (one project per environment)"]
		AUTH["Auth<br/>6-digit email codes, anonymous guests"]
		REST["PostgREST RPC<br/>push_changes, pull_changes, online functions"]
		POOL["Supavisor pooler<br/>transaction mode"]
		PG[("Postgres<br/>public, private, api schemas, RLS")]
	end
	PHOLIO["Pholio (future)<br/>external, read-only consumer"]

	PWA -- "HTTPS, no credential" --> STATIC
	PWA & IOS & AND -- "HTTPS, publishable key" --> AUTH
	PWA & IOS & AND -- "HTTPS, publishable key + user JWT" --> REST
	REST --> PG
	PHOLIO -- "HTTPS, Bearer hsk_ token" --> API
	API -- "TLS, role handshake_api" --> POOL --> PG
```

- **Devices** run the same React build. The PWA loads it from Vercel once, then the service worker serves
  it offline. The native apps ship `dist/` inside the binary, so they never load the site from Vercel.
- **Supabase** is the system of record: Postgres holds every group's rows, Auth issues JWTs. Devices reach
  Postgres only through PostgREST RPC calls made in `src/lib/sync/supabase-transport.ts`.
- **Vercel** hosts the static site and one serverless function for `/api/v1/*`.
- **Pholio** is outside Handshake's trust boundary. It calls `/api/v1` with a token the person made in
  Handshake. Handshake never calls Pholio and stores nothing about it.

## 3. Components

```mermaid
flowchart TB
	subgraph client["Client (src/), the same on web and native"]
		SCREENS["pages/*, components/*<br/>read only from Dexie via useLiveQuery"]
		ACTIONS["lib/changes.ts<br/>commit(intent): read, planChange, apply, queue<br/>in one transaction"]
		LEDGER["lib/ledger.ts<br/>computeShares, validateEntry, summarizeGroup (pure)"]
		LOCAL["lib/sync/local.ts<br/>applyMutation, mergePull (pure over LocalTables)"]
		DEXIE[("Dexie / IndexedDB<br/>groups, members, entries, conflicts,<br/>invites, inviteTokens, outbox, cursors")]
		ENGINE["lib/sync/engine.ts + controller.ts<br/>push then pull; on start, change, reconnect, focus, 1/min"]
		TRANSPORT["lib/sync/supabase-transport.ts<br/>the only file that talks to Supabase about data"]
	end
	subgraph server["Vercel function (src/server/api-v1/)"]
		ADAPTER["api/v1/[...path].ts<br/>composition root"]
		HANDLER["createApiV1(store)<br/>handle(request) → response"]
		STORE["ApiStore seam: postgres-store.ts<br/>(or the in-memory fake in tests)"]
	end
	subgraph db["Postgres"]
		PUSHPULL["public.push_changes / pull_changes"]
		ONLINE["public.preview_invite, join_group, upgrade_guest,<br/>create/list/revoke_api_token"]
		PRIVATE["private.apply_* per mutation type,<br/>compute_shares, next_group_version, checks"]
		APIFN["api.v1_me, v1_groups, v1_group, v1_payments"]
		TABLES[("groups, group_members, ledger_entries, ledger_shares,<br/>entry_conflicts, ledger_entry_versions, group_invites,<br/>api_tokens, sync_mutations, profiles")]
	end

	SCREENS --> ACTIONS --> LOCAL --> DEXIE
	SCREENS --> LEDGER
	SCREENS -.-> DEXIE
	ACTIONS --> LEDGER
	ENGINE --> TRANSPORT --> PUSHPULL --> PRIVATE --> TABLES
	ENGINE --> LOCAL
	ACTIONS --> TRANSPORT --> ONLINE --> TABLES
	ADAPTER --> HANDLER --> STORE --> APIFN --> TABLES
	HANDLER --> LEDGER
```

`src/lib/ledger.ts` is imported by both the client and the API function, so the app and Pholio see the
same balances and debts. It has no runtime imports outside itself (see §8.3). §9 is the
module map: every module's interface, seam, adapters and test surface.

## 4. Data flow

### 4.1 Writing (offline-first)

```mermaid
sequenceDiagram
	participant UI as Screen
	participant M as commit(intent)
	participant D as Dexie
	participant E as Sync engine
	participant P as push_changes()
	participant Q as pull_changes()

	UI->>M: addExpense {groupId, draft}
	M->>D: one transaction: read group state, planChange,<br/>applyMutation + outbox.add per mutation
	D-->>UI: useLiveQuery re-renders (balance changes at once)
	M-->>UI: Plan {ok, mutations, createdId} or a refusal
	M->>E: requestSync() (only if something was queued)
	Note over E: offline? stop; retry on 'online', focus, or the 1-minute timer
	E->>P: outbox in batches of 50
	P->>P: per mutation: savepoint, already in sync_mutations? skip,<br/>else private.apply_*(); stamp next_group_version()
	P-->>E: {applied: [ids], rejected: [{id, code, reason}]}
	E->>D: remove applied + rejected from outbox; toast per rejected code
	E->>Q: cursors {groupId: version}
	Q-->>E: groupIds + per-group changes past each cursor
	E->>D: mergePull: drop gone groups, put server rows, replay still-unsent mutations
```

Rules that hold the flow together (unchanged from `AGENTS.md`, restated because chats 2 and 3 extend them):

1. **One way to change data.** Every change starts as an intent and is carried out by `Mutation`s.
   `commit(intent)` (§9.4, replacing today's `mutate()`) is the only writer of Dexie tables apart from
   `mergePull`, and `push_changes()` is the only writer of server tables. Chat 3 updates `AGENTS.md` to
   say so when it builds `commit`.
2. **Exactly once.** A mutation id is recorded in `sync_mutations` in the same savepoint as its effect.
   A retried push reports it applied without applying it again.
3. **Ordered versions.** Every server write takes `private.next_group_version(group_id)`, which locks the
   group row, so versions in a group commit in order and a cursor can never skip a write in flight.
   Every new synced table has `row_version` stamped this way and an index on `(group_id, row_version)`.
4. **Children travel with their parent.** An entry's `items` and all its `shares` come back with every
   pull of that entry and replace the local copy whole (spec decision 7). Conflicts and invites are their
   own rows with their own `row_version`.
5. **Server rows win once they arrive**; still-unsent mutations are replayed on top (`mergePull`).
6. **Soft deletes everywhere** (`deleted_at`) so other devices receive them.

### 4.2 Conflicts

A conflict is decided on the server, during push, by `private.apply_entry_update` / `apply_entry_delete`:

| Stored entry vs. the mutation's `baseVersion`                     | Result                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `row_version = baseVersion`                                       | Applied                                                                     |
| `row_version > baseVersion`, `updated_by_member_id` is the caller | Applied (same person on two devices; last one wins)                         |
| `row_version > baseVersion`, changed by someone else              | Not applied, **not rejected**: one `entry_conflicts` row; counts as applied |
| Entry never reached the server (its create was rejected)          | Accepted, does nothing                                                      |

The conflict row stamps the next group version, and so does every write to the entry. The device's
`mergePull` mirrors the rule: an unsent `entry.update` or `entry.delete` whose entry is now newer and was
changed by someone else is not replayed locally; the server will turn it into a conflict. Balances always
use the entry's current version. Resolving is a normal mutation (`conflict.resolve`); the first resolver
wins and a second gets `HS409`.

### 4.3 Online-only calls

Joining a group, previewing an invite, upgrading a guest and managing API tokens cannot be mutations:
the caller is not yet a member, or the result (a token) must be shown once. They are RPC calls through
`supabase-transport.ts`, and the screens that use them say "needs a connection" when offline. After
`join_group` or `upgrade_guest`, the device runs a sync so the group arrives through the normal pull.

### 4.4 Reading for Pholio (API v1)

```mermaid
sequenceDiagram
	participant X as Pholio (server side)
	participant H as /api/v1 handler (Vercel)
	participant S as postgres-store
	participant F as api.v1_*() (SECURITY DEFINER)
	participant T as Tables

	X->>H: GET /api/v1/payments?cursor=… <br/>Authorization: Bearer hsk_…
	H->>H: token format check; SHA-256 hex; parse limit and cursor (400 if bad)
	H->>S: payments(tokenHash, {groupId: null, cursor, limit})
	S->>F: SELECT api.v1_payments($1, $2, $3, $4)
	F->>T: authenticate: token row by hash, not revoked;<br/>rate window +1; last_used_at = now()
	alt unknown or revoked
		F-->>H: SQLSTATE HS401 → 401 invalid_token
	else over 60 in this minute
		F-->>H: SQLSTATE HS429 → 429 rate_limited + Retry-After
	end
	F->>T: one statement: the owner's groups, confirmed payments past the cursor<br/>that involve the owner, with direction and counterparty
	F-->>S: {payments, cursor, hasMore, removedGroupIds}
	S-->>H: typed rows
	H->>H: encode cursor; ISO timestamps
	H-->>X: 200 {payments, nextCursor, hasMore, removedGroupIds}<br/>Cache-Control: no-store
```

- The API never sees Supabase's URL or keys and Pholio never sees Postgres. The only coupling to
  Supabase is the connection string.
- **Every `api.v1_*` function takes the token hash, not a user id.** It authenticates inside the same call
  and returns only that token owner's data. The `handshake_api` database password alone therefore reads
  nothing: a caller also needs a live token (ADR-003).
- Balances and debts are worked out in the handler with `src/lib/ledger.ts` from per-member totals
  and per-pair totals that SQL sums from stored shares and parts. Payments come straight from stored rows.
- The payments feed pages with a **sync cursor**: an opaque token holding, per group, the last version
  Pholio has seen, exactly like the device's pull cursors. It is safe against commits landing out of
  timestamp order, picks up groups the person joins later, and reports groups they lost (ADR-004).

## 5. Network and security boundaries

### 5.1 Who talks to what

| From                       | To                            | Credential                                          | Allowed                                                                                                       |
| -------------------------- | ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Browser                    | Vercel static                 | none                                                | Download the app shell                                                                                        |
| Any device                 | Supabase Auth                 | publishable key; email + 6-digit code, or anonymous | Get a JWT (1 h) and a rotating refresh token                                                                  |
| Signed-out device          | PostgREST (`anon`)            | publishable key                                     | `preview_invite` only                                                                                         |
| Signed-in device           | PostgREST (`authenticated`)   | publishable key + user JWT                          | `push_changes`, `pull_changes`, online functions; `SELECT` through RLS                                        |
| Pholio (its server)        | Vercel `/api/v1`              | `Authorization: Bearer hsk_…`                       | `GET` the token owner's data                                                                                  |
| Vercel API function        | Supavisor → Postgres          | `handshake_api` password (Vercel env, server only)  | `EXECUTE` on `api.*`, each call needing a valid token hash                                                    |
| Owner's machine            | Supabase project              | Supabase CLI login + database password              | `supabase db push` (migrations), dashboard settings                                                           |
| Signed-in device (slice 8) | Supabase Realtime (WebSocket) | user JWT                                            | Subscribe to `group:<id>` signals for its own groups (RLS on `realtime.messages`); receive `{ version }` only |
| Handshake (any part)       | Pholio                        | —                                                   | **Never**                                                                                                     |

No component uses the Supabase secret (service-role) key at runtime, and it is never deployed.

### 5.2 Authentication

- **People** sign in with a 6-digit email code (Supabase OTP). The JWT's `sub` is the user id that every
  RLS policy and `push_changes()` uses.
- **Guests** use Supabase anonymous sign-in: a real `auth.users` row, role `authenticated`, with
  `is_anonymous: true` in the JWT. `private.is_anonymous()` reads that claim. Anonymous callers cannot
  create groups or API tokens; their member rows have role `guest`, which limits what `push_changes()`
  lets them do. Adding an email later keeps the same user id; `upgrade_guest()` turns their `guest` rows
  into `member`.
- **API tokens** (`hsk_` + 43 base64url characters, 256 random bits) are made by `create_api_token()`,
  shown once, and stored only as the hex SHA-256 of the whole string. The handler hashes the presented
  token itself, so the raw token never reaches Postgres. Tokens are read-only, see exactly what their
  owner sees, never expire, and stop working the moment they are revoked.

### 5.3 Database roles

| Role            | Used by                                       | Gets                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anon`          | Signed-out devices                            | `EXECUTE public.preview_invite(TEXT)`. Nothing else.                                                                                                                                                                                     |
| `authenticated` | Signed-in people and guests                   | `SELECT` on group tables through RLS (`group_invites` without `token_hash`); `EXECUTE` on `push_changes`, `pull_changes` and the online functions. Nothing on `api_tokens`, `sync_mutations`, `ledger_entry_versions`, `private`, `api`. |
| `handshake_api` | The Vercel function, via the pooler           | `LOGIN`, `USAGE` on schema `api`, `EXECUTE` on `api.v1_*`. No table privileges anywhere, no `EXECUTE` on `public` or `private` functions (pgTAP checks the catalogue).                                                                   |
| `postgres`      | Migrations; owns `SECURITY DEFINER` functions | Everything. Used only by the owner's CLI.                                                                                                                                                                                                |

The `api` schema is **not** listed in `supabase/config.toml` `[api].schemas`, so PostgREST never exposes it.
Every function in `private` and `api` is `SET search_path = ''` and schema-qualifies every name.

### 5.4 Row-level security

- RLS is on for every table. Group tables have one `SELECT` policy: `public.is_group_member(group_id)`
  (`SECURITY DEFINER`, so policies don't recurse). Clients have no `INSERT`, `UPDATE` or `DELETE` grant on
  any table.
- `push_changes()` is `SECURITY DEFINER` and does its own checks per mutation: active member, open group,
  role allows it (spec decision 8), the data is valid. `pull_changes()` is `SECURITY INVOKER` and relies on
  RLS.
- `api.v1_*` functions are `SECURITY DEFINER` (they bypass RLS) and filter by the user the token resolves
  to. pgTAP proves a token only sees its owner's groups and shares.

### 5.5 Rate limits

| Surface                        | Limit                                                                                             | Enforced by                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| Sign-in emails                 | `email_sent = 2` per hour locally; production needs custom SMTP and a higher limit                | Supabase Auth                 |
| Sign-ins and code checks       | 30 per 5 minutes per IP (`sign_in_sign_ups`, `token_verifications`)                               | Supabase Auth                 |
| Anonymous sign-ins             | 30 per hour per IP, plus Cloudflare Turnstile in production                                       | Supabase Auth                 |
| `push_changes`, `pull_changes` | No app-level limit; devices sync on change, on reconnect, on focus and once a minute              | Supabase platform             |
| `/api/v1`, per token           | **60 requests per minute** (fixed one-minute window); `429 rate_limited` with `Retry-After`       | `api.*` in Postgres (ADR-003) |
| `/api/v1`, malformed tokens    | Rejected with 401 before any database call                                                        | Handler                       |
| `/api/v1`, per IP (optional)   | A Vercel Firewall rate-limit rule on `/api/v1/*` if the plan allows                               | Vercel                        |
| Realtime (slice 8)             | Free: 200 concurrent connections, 100 messages/s, 2 million a month; Pro: 500, then $10 per 1,000 | Supabase Realtime             |

### 5.6 Environments and secrets

MVP has two environments: **local** and **production**. Vercel preview deployments use production's
values (the client is public anyway, and the API role reads nothing without a token). A staging Supabase
project can be added later without code changes.

| Variable or setting                           | Local                                                                     | Production                                                                                  | Secret?                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `VITE_SUPABASE_URL`                           | `http://127.0.0.1:55321` (`.env.local`)                                   | Project URL (Vercel env, all environments; baked into native builds)                        | No                                                       |
| `VITE_SUPABASE_PUBLISHABLE_KEY`               | From `bunx supabase status`                                               | Project publishable key                                                                     | No (public)                                              |
| `HANDSHAKE_API_DATABASE_URL`                  | `postgresql://handshake_api:handshake_api_local@127.0.0.1:55322/postgres` | Supavisor transaction pooler, port 6543, user `handshake_api.<project-ref>`                 | **Yes** (Vercel "Sensitive", server only, never `VITE_`) |
| `handshake_api` password                      | Set by `supabase/seed.sql` (local only)                                   | Set once by the owner: `ALTER ROLE handshake_api WITH LOGIN PASSWORD '…'` in the SQL editor | **Yes**                                                  |
| Database password, Supabase access token      | Not needed                                                                | Owner's machine only, for `supabase db push`                                                | **Yes**                                                  |
| Auth: anonymous sign-ins, manual linking      | `supabase/config.toml`                                                    | Dashboard → Authentication                                                                  | No                                                       |
| Auth: Turnstile secret                        | Off                                                                       | Dashboard → Authentication → Bot protection                                                 | **Yes**                                                  |
| Auth: SMTP credentials                        | Mailpit on 55324                                                          | Dashboard → Authentication → SMTP                                                           | **Yes**                                                  |
| Supabase secret / service-role key            | Not used                                                                  | Not used, never stored in Vercel                                                            | —                                                        |
| FCM service account, push secret (push stage) | Not used                                                                  | Vercel env (`FCM_SERVICE_ACCOUNT_JSON`, `HANDSHAKE_PUSH_SECRET`), server only               | **Yes**                                                  |

Nothing from Pholio is stored in Handshake, and none of Pholio's keys or URLs appear in this repo.

## 6. Technology and platforms

| Area                   | Choice                                                                             | Why                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Runtime and tooling    | Bun 1.3, for every script, tool and the API function (ADR-006)                     | One fast tool for install, scripts and tests; runs TypeScript directly.                              |
| Node.js                | 26 LTS, only where a host needs it (ADR-006)                                       | Vercel's build image, and the fallback runtime for the API function.                                 |
| Client                 | Vite 7, React 19, React Router 7, static SPA                                       | A static build is what both the PWA and Capacitor need; no server rendering to host or keep offline. |
| Local store            | Dexie (IndexedDB) with `useLiveQuery`                                              | Screens re-render from local rows, so the app works the same with or without signal.                 |
| Offline web            | `vite-plugin-pwa` (Workbox)                                                        | Caches the app shell so the site opens offline and can be installed.                                 |
| Mobile                 | Capacitor 8 bundling `dist/`                                                       | One codebase; the binary contains the app, so it opens offline; native share sheet.                  |
| Backend                | Supabase: Postgres 17, RLS, Auth, PostgREST RPC                                    | Postgres does the sync and validation in transactions; Auth covers email codes and anonymous guests. |
| Sync                   | Own mutation log + per-group versions, no Realtime                                 | Exactly-once, ordered, works offline, and keeps the backend swappable behind one transport file.     |
| API for Pholio         | TypeScript on a Vercel Function (Bun runtime), OpenAPI 3.1                         | Shares `ledger.ts`, same repo and deploy, testable in Bun (ADR-001, ADR-002, ADR-006).               |
| API database driver    | Bun's built-in `SQL` (`Bun.sql`), `prepare: false`                                 | No dependency; works with Supavisor transaction mode. `postgres` (porsager) v3 is the fallback.      |
| UI                     | Tailwind 3.4 with Pholio's tokens, Radix, sonner, lucide                           | Matches the owner's other app and stays accessible.                                                  |
| Tests                  | `bun test`, pgTAP (`supabase test db`), Ajv for contract checks                    | Pure logic in Bun, SQL in SQL, the HTTP contract checked against the YAML.                           |
| Live updates (slice 8) | Supabase Realtime Broadcast as a change signal; `react-virtuoso` for the chat list | Already in the stack; the signal only triggers the existing pull (ADR-009).                          |
| Hosting                | Vercel (site + function), Supabase cloud                                           | Free or cheap at friend-group scale; preview deploys per branch.                                     |

## 7. Architecture decisions

### ADR-001: The Pholio API is TypeScript on a Vercel Function in this repo

- **Status:** Accepted (confirms spec decision 14). The runtime is Bun, not Node (ADR-006, 2026-11-03).
- **Context:** Pholio will integrate against `/api/v1` later and must keep working while Handshake changes.
  What matters: a stable, versioned contract; an OpenAPI document Pholio can generate a client from; the
  same balance and settle-up logic as the app (`src/lib/ledger.ts`); tests that run with the rest of the
  repo; cheap hosting that one person can run.
- **Decision:** One Vercel serverless function (Bun runtime, ADR-006) at `api/v1/[...path].ts`, a thin adapter over
  a framework-free handler in `src/server/api-v1/` that takes a Web `Request` and returns a `Response`.
  It connects to Postgres through Supavisor as `handshake_api` and calls one `api.v1_*` function per
  request.

| Option                                     | Contract stability                    | OpenAPI                       | Shares `ledger.ts`                                   | Testability                      | Hosting                             | Verdict                                                     |
| ------------------------------------------ | ------------------------------------- | ----------------------------- | ---------------------------------------------------- | -------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| **TypeScript, Vercel Function**            | Own HTTP layer                        | Contract-first YAML (ADR-002) | Yes, same import                                     | `bun test` with a fake store     | Same project and deploy as the site | **Chosen**                                                  |
| TypeScript, Supabase Edge Function (Deno)  | Own HTTP layer                        | Same                          | Only via Deno-compatible imports and a second bundle | Deno test runner, separate setup | Tied to Supabase; separate deploy   | Rejected                                                    |
| Python FastAPI or Go on Fly/Render         | Own HTTP layer                        | Generated from code (FastAPI) | No: ledger logic rewritten in a second language      | Second toolchain                 | Another host and bill               | Rejected                                                    |
| Expose PostgREST/RPC to Pholio             | Couples Pholio to tables and Supabase | PostgREST's own               | No                                                   | —                                | Free                                | Rejected                                                    |
| TypeScript with Hono + `@hono/zod-openapi` | Same                                  | Generated from code           | Yes                                                  | Same                             | Same                                | Deferred: worth it if write endpoints or ~15+ routes arrive |

- **Consequences:**
  - The handler uses only Web standards (`Request`, `Response`, `URL`, `crypto.subtle`), so it runs
    unchanged in Bun tests, Vercel's Bun runtime, or Node 26 on Vercel if the Bun runtime has to be dropped.
  - The rounding and settle-up logic exists once in TypeScript (plus the SQL check of shares, spec
    decision 3).
  - Vercel's function builder does not reliably resolve the `@/` path alias at runtime. Files the function
    loads at runtime use **relative** imports; `import type` may still use `@/` (types are erased). A unit
    test guards this (`tests/server/import-paths.test.ts`). `bunx vercel build` needs the owner's Vercel
    login, so chat 3 could not run it (2026-11-08); `bun build --target=bun` bundles the function with
    relative imports, and the bundle answers requests against the local stack. Keep the rule until a real
    Vercel build shows aliases resolve.

### ADR-002: The contract is written first, as OpenAPI 3.1, and tests hold the code to it

- **Status:** Accepted (new).
- **Decision:** `docs/api-v1.openapi.yaml` is the source of truth for shapes; `docs/api-v1.md` explains
  behaviour in prose. Response types in `src/server/api-v1/types.ts` are written by hand to match. Contract
  tests load the YAML and validate every response the handler produces with Ajv (JSON Schema 2020-12, which
  OpenAPI 3.1 uses). In the tests every response schema is closed (`unevaluatedProperties: false` on each
  object and on each `allOf`, leaving the `allOf` branches themselves open, because a closed branch would
  reject the fields its siblings define, such as `GroupDetail`'s `debts`), so a field the handler adds
  without documenting it fails, even though Pholio must tolerate extra fields.
- **Why:** with five read-only routes a framework adds weight without much gain. A hand-reviewed YAML
  makes every contract change a visible diff, and the closed-schema tests stop code and contract drifting.
- **Rejected:** generating the YAML from code (contract changes become a side effect of refactors);
  generating TypeScript from the YAML (a codegen step and a generated file to keep current, for five
  types).

### ADR-003: API SQL functions take the token hash, and rate-limit in Postgres

- **Status:** Accepted (revises spec decision 14's `api.resolve_token(hash)` returning a user id).
- **Decision:** each `api.v1_*(p_token_hash, …)` first calls `private.api_authenticate(p_token_hash)`, which
  in one `UPDATE` on `api_tokens` finds the live token, moves the one-minute rate window, adds 1, sets
  `last_used_at`, and returns the user id. Unknown or revoked → `HS401`; over 60 in the window → `HS429`
  (the exception rolls the increment back, so refused calls don't count). Then one SQL statement builds the
  response from a single snapshot.
- **Why:** if the `handshake_api` password leaks, it can't read anyone's data without also holding a live
  token. One round trip per request. No extra service for rate limiting, and the counter lives with the
  token it limits.
- **Trade-off:** each request writes one row. At 60 requests a minute per token that is nothing.
- **Rejected:** functions taking a user id (the DB password would read everything); Redis/Upstash for rate
  limits (another service and secret for one counter).

### ADR-004: The payments feed pages with an opaque per-group version cursor

- **Status:** Accepted (revises the spec's `updatedSince` timestamp; on 2026-11-04 the feed became
  payments only, replacing the entries feed, before anything shipped).
- **Decision:** `GET /payments` and `GET /groups/{id}/payments` take `cursor` and `limit` and return
  `{ payments, nextCursor, hasMore, removedGroupIds }`. Only payments that involve the person and count
  are returned. The cursor is base64url JSON
  `{"v":1,"scope":"all"|"<groupId>","groups":{"<groupId>":<version>}}`; Pholio treats it as opaque. A
  payment's feed version is the `row_version` it took when it started to count; a payment that counts
  never changes, so the feed only adds rows.
- **Why:** `updated_at` is the writing transaction's start time, so a row can commit after a later
  timestamp has been read and a timestamp cursor would skip it. Per-group versions are already ordered by
  `next_group_version()`'s lock. The cursor also knows which groups Pholio has seen, so it can return a
  new group's whole history and report groups the person left or that were deleted. Payments only,
  because Pholio records money that moved (owner, 2026-11-04).
- **Rules:** a page never splits the payments of one group version (it may return slightly more than
  `limit`); `nextCursor` is always returned, and Pholio stores it for next time; `hasMore: true` means call
  again now.

### ADR-005: No admin role

- **Status:** Accepted (owner, 2026-11-03; revises spec decision 8; widened on 2026-11-04).
- **Decision:** roles are `owner`, `member`, `guest`. The owner alone removes people, renames others,
  renames the group, completes and reopens it, and deletes it. Members can also add people by name and
  make invites (revoking only their own). When the owner leaves, ownership passes to the full member who
  joined first (`joined_at`, then `id`); when no full member is left, the group is deleted. The full
  matrix is spec decision 8 (ADR-007).
- **Trade-off:** if the owner is away, nobody else can complete the group or remove people. A "Make
  owner" handover is a possible later addition (a new mutation; no schema change).

### ADR-006: Bun everywhere; Node 26 LTS only where a host needs it

- **Status:** Accepted (owner, 2026-11-03).
- **Context:** The owner wants Bun wherever it works, and Node only where it is really needed, on its
  latest LTS (26, from 2026-10-28). Until now `bun run dev`, `build`, `typecheck` and `format` started
  Vite, `tsc` and Prettier under Node, because their launchers ask for `node`; the API function was
  planned for Vercel's Node runtime.
- **Decision:**
  - Every script runs its tool under Bun with `bun --bun` (Vite dev, build and preview, `tsc`, Prettier,
    the Capacitor CLI). Checked on 2026-11-03: all of them work, the PWA build included.
  - `package.json` pins `"packageManager": "bun@1.3.3"`, which CI reads (`bun-version-file`).
  - The API function runs on Vercel's **Bun runtime** (`"bunVersion": "1.x"` in `vercel.json`, the Bun 1.3
    line). It talks to Postgres through `Bun.sql` with `prepare: false`, so it needs no driver package.
  - Node stays only where a host brings it: Vercel's build machine, and the fallback runtime if Bun's has to
    go. `"engines": { "node": "26.x" }` pins both to Node 26 LTS. Nothing in the repo runs Node directly,
    so a developer machine doesn't need it for Handshake.
  - CI actions use their current majors (`actions/checkout@v7`, `supabase/setup-cli@v3`,
    `oven-sh/setup-bun@v2`), which run on the runner's Node 24 instead of the deprecated Node 20.
- **Trade-offs:**
  - Vercel's Bun runtime is in **public beta**. It has no automatic source maps and no request metrics on
    `node:http`, neither of which this function uses. The way back is one line: remove `bunVersion`, and
    the same handler runs on Node 26.
  - `Bun.sql` is younger than `postgres`. The `ApiStore` seam keeps the choice local to
    `postgres-store.ts`, and the store contract suite (§9.11) proves whichever one is used.
  - Bun 1.4 (Vercel's `"1.4.x"`) is a rewrite with breaking changes. Stay on 1.3 until it has been tried
    here on its own branch.
- **Rejected:** keeping the Node runtime for the function (works, but goes against the owner's rule and
  adds a second runtime to test against); `.nvmrc` or `.node-version` files (nothing local needs Node,
  and `engines` is what Vercel reads).
- **Revisit:** when Vercel's Bun runtime leaves beta, and when moving to Bun 1.4.

### ADR-007: One permission matrix, mirrored in TypeScript and SQL, held in step by a case table

- **Status:** Accepted (architecture review candidate 2, 2026-11-04).
- **Context:** who may do what was written as 15 role arrays passed to `require_member` across 004–008,
  plus inline checks, and `planChange` would have written it a second time on the device.
- **Decision:**
  - The matrix of actions × roles, plus "allowed in a completed group", is spec decision 8's table.
  - **SQL:** `private.may(action, role)` and `private.allowed_when_completed(action)` (immutable),
    asked through `private.require(user, group, action)`, which replaces `require_member`'s role array.
    Each `apply_*` works out which action it is doing (own or others', self or others) and asks once.
  - **TypeScript:** M10 `src/lib/permissions.ts`, used by `planChange` and by screens to show or hide
    buttons (§9.14).
  - **One case table:** `tests/fixtures/permission-cases.ts`, transcribed by hand; generated into
    `supabase/tests/permission_cases.test.sql` by `scripts/permission-cases-sql.ts`; the drift test covers
    it like the ledger cases (§9.13).
  - Only booleans and codes are pinned; each side words its own refusal reasons.
  - 004–008 are edited in place: on 2026-11-04 they had run only on local stacks.
- **Rejected:** generating the SQL function from the TypeScript matrix (production code generated into
  migrations, and the TypeScript tested against itself); a seeded `permissions` table (rows, grants and
  re-run safety for something that is code).

### ADR-008: Payments are handshakes, and debts are worked out between pairs

- **Status:** Accepted (owner, 2026-11-04).
- **Decision:**
  - A payment is `pending` until both sides agree (`payment.record`, then `payment.confirm`), or
    `declined` / `undone`. Only `confirmed` payments count. A payment with a name-only person is
    confirmed when recorded. Confirmed payments never change. Payments have their own mutations and never
    enter the conflict flow (spec decision 17).
  - A debt is between two people: what A owes B from bills minus what B owes A, adjusted by confirmed
    payments between them. Nothing is simplified across the group (spec decision 18).
  - To make that a sum over stored rows, shares gain `owedTo` (`ledger_share_parts` on the server), and
    rounding is per payer: each payer absorbs the cent on their own items. Single-payer bills are
    unchanged; one pinned case changes (spec Testing Checklist).
  - Everything syncs to every member as before; pending payments and nudges are shown only to their two
    people by the screens.
- **Why:** the app is named for the handshake: a payback is real when both people agree. Pairwise debts
  follow, because a handshake is always between two real people.
- **Consequences:** `summarizeGroup` returns pairwise debts instead of greedy suggestions; the settle-up
  tracker becomes a progress view; the API serves payments (ADR-004).

### ADR-009: Live updates use Supabase Realtime as a change signal only

- **Status:** Accepted (owner, 2026-11-04; slice 8; revises the "no Realtime" rule in `AGENTS.md`).
- **Decision:** after `push_changes` (and any online function) changes a group, Postgres sends one
  Broadcast `{ version }` on the private channel `group:<id>` with `realtime.send()`. Devices subscribe
  to their groups while open and answer a signal with `requestSync()`. Data still arrives only through
  `pull_changes` and the message feed. Members-only access is an RLS policy on `realtime.messages`.
- **Why:** WhatsApp's model (a socket is the fast path, the stored log is the truth) with what the stack
  already has. Exactly-once, ordering, offline use and the transport seam are untouched; a dropped socket
  only costs latency.
- **Rejected:** Postgres Changes (data bypassing the pull and merge); Ably, Pusher, PubNub (new vendor);
  a self-hosted socket server (Vercel functions can't hold sockets); polling alone.
- **Consequences:** `AGENTS.md` rule 6 and "Don't enable Supabase Realtime" are reworded when slice 8 is
  built; a Free project's 200 concurrent connections become a limit to watch (§5.5).

### ADR-010: Chat messages have their own newest-first feed and a 500-message cache

- **Status:** Accepted (owner, 2026-11-04; slice 8).
- **Decision:** messages are written through `push_changes` like everything else, but read through their
  own feed, `pull_messages(group, since)` (newest first, up to 500, with a `gap` flag) and
  `message_history(group, before, limit)`. `pull_changes` carries only each group's `message_version`,
  its pins and its nudges. Each device keeps the newest 500 messages per group; older ones load on
  scroll and are trimmed at the next start.
- **Why:** a new device should see today's messages first, as in WhatsApp, and storage should stay
  predictable. `pull_changes` returns oldest first, and a chat can outgrow everything else in a group.
- **Rejected:** messages in `pull_changes` (oldest first; first sync of a busy chat would be slow); the
  whole history on every device (the owner chose a cache).

## 8. The MVP

### 8.1 Scope boundary

**In the MVP:** all seven slices of the spec's Implementation Guide, for the database (chat 2) and the
domain logic, sync and API (chat 3):

| Slice | 1               | 2                      | 3                         | 4              | 5                        | 6                                          | 7                 |
| ----- | --------------- | ---------------------- | ------------------------- | -------------- | ------------------------ | ------------------------------------------ | ----------------- |
| What  | Dollars, people | Bills, items, balances | Debts, handshake payments | Edit conflicts | Invites, guests, joining | Settle up, completing, deleting an account | API v1 (payments) |

**Not in chats 2 and 3:** the screens. Chats 2 and 3 leave the app compiling and working as it does today
(groups and rename), with every new capability reachable from `src/lib/*` and covered by tests. The
screens in the spec's "Screens" section are a fourth piece of work that builds on chat 3.

**After the MVP:** slice 8, the group chat, nudges and live updates (`docs/chat-spec.md`), in the same
three passes; push notifications are its final stage.

**Out of the MVP entirely:** everything in the spec's "Out of Scope", plus ownership handover, OAuth for
the API, a staging Supabase project, and universal links.

### 8.2 Build order

```mermaid
flowchart LR
	subgraph c2["Chat 2: database"]
		M4["004 people"] --> M5["005 ledger"] --> M6["006 conflicts"] --> M7["007 invites"] --> M8["008 complete"] --> M9["009 api"]
	end
	subgraph c3["Chat 3: logic, sync, API"]
		L1["M7 money + M1 ledger"] --> L2["M3 local replica, wire, Dexie v2"] --> L3["M2 planChange + commit, M8 online functions"] --> L4["M9 API + ApiStore adapters"] --> L5["contract suites + vercel build"]
	end
	c2 --> c3
```

Each migration lands with its pgTAP file and leaves `bun run db:reset`, `bun run test:db`, `bun test`,
`bun run typecheck` and `bun run build` green, so the app keeps working between steps. Chat 3 may start
`ledger.ts` before chat 2 finishes, since it is pure.

### 8.3 Code layout added by the MVP

```
api/v1/[...path].ts            composition root: postgres client + store → createApiV1 (M9)
src/server/api-v1/
  index.ts                     createApiV1 — the module's whole interface
  store.ts                     ApiStore seam: interface, row types, ApiStoreError
  postgres-store.ts            production ApiStore adapter (one SELECT api.v1_* per method)
  http.ts, cursor.ts, token.ts internal; no tests of their own
  types.ts                     response types, matching docs/api-v1.openapi.yaml
src/lib/
  ledger.ts                    M1, pure (client and API)
  changes.ts                   M2 planChange + createCommitter/commit + useCommit
  permissions.ts               M10 may() and allowedWhenCompleted()
  groups.ts, members.ts, entries.ts, invites.ts   read hooks only
  sync/                        M3–M5, M8: types, wire, local, dexie-store, engine, controller, transport
scripts/ledger-cases-sql.ts    renders the shared ledger case table into pgTAP (§9.13)
scripts/permission-cases-sql.ts renders the permission case table into pgTAP (ADR-007)
supabase/migrations/004…009    see §11
supabase/seed.sql              local-only: handshake_api login password
supabase/tests/ledger_cases.test.sql   generated; never edited by hand
tests/fixtures/ledger-cases.ts, permission-cases.ts   the shared hand-written case tables
tests/support/                 memory-tables.ts (LocalTables), memory-api-store.ts (ApiStore)
tests/lib/…, tests/api/…, tests/server/…
```

Runtime imports inside `src/server/api-v1/` and from it into `src/lib/ledger.ts` are relative. `ledger.ts`
has no runtime imports at all.

## 9. Module map

The system is designed as **deep modules**: a lot of behaviour behind a small **interface**, placed at a
**seam** where it can be swapped, and tested through that interface. Terms are used as in the
`codebase-design` skill:

- **Module:** anything with an interface and an implementation, from one function to a tier-spanning slice.
- **Interface:** everything a caller must know: the signature, plus invariants, ordering, error modes and
  configuration.
- **Depth:** behaviour a caller gets per unit of interface learned. **Leverage** is what callers gain from
  it, and **locality** is what maintainers gain (change and bugs concentrate in one place).
- **Seam:** where a module's interface lives, so behaviour can change without editing the caller.
- **Adapter:** a concrete thing that fills a seam.

Rules applied to every module below:

1. **The interface is the test surface.** Tests call what callers call. Internal files have no tests of
   their own.
2. **A seam needs two real adapters** (production plus a fake counts). A seam with one adapter is
   hypothetical and is not drawn.
3. **The deletion test.** A module stays only if deleting it would push complexity back into several
   callers. Pass-through modules are folded into their callers.
4. **Accept dependencies, return results.** Logic takes what it needs as arguments and returns a value;
   side effects live in a thin composition root at the edge.

### 9.1 Overview

| #   | Module                    | Where                                                       | Interface                                           | Seam (adapters)                                                                                                                         | Test surface                                                    | Built by       |
| --- | ------------------------- | ----------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------- |
| M1  | Ledger                    | `src/lib/ledger.ts`                                         | 3 pure functions                                    | none (in-process)                                                                                                                       | `tests/lib/ledger.test.ts` + shared case table                  | Chat 3         |
| M2  | Change planner            | `src/lib/changes.ts`                                        | `planChange()` (pure) + `commit(intent)`            | none (in-process)                                                                                                                       | `changes.test.ts`, `changes.commit.test.ts`                     | Chat 3         |
| M3  | Local replica             | `src/lib/sync/local.ts`                                     | `applyMutation()`, `mergePull()`                    | **`LocalTables`** (`dexieTables`, `createMemoryTables`)                                                                                 | `tests/lib/sync/local.test.ts`, `merge.test.ts`                 | Chat 3         |
| M4  | Sync engine               | `src/lib/sync/engine.ts`                                    | `syncOnce(store, transport)`                        | **`SyncStore`** (`createDexieSyncStore`, fake in `engine.test.ts`); **`SyncTransport`** (`supabaseTransport`, fake in `engine.test.ts`) | `tests/lib/sync/engine.test.ts`                                 | Exists; chat 3 |
| M5  | Sync controller           | `src/lib/sync/controller.ts`                                | `startSync()`, `requestSync()`, `useSyncStatus()`   | none                                                                                                                                    | By hand (offline → online)                                      | Exists         |
| M7  | Money                     | `src/lib/money.ts`                                          | `parseAmount()`, `formatAmount()`                   | none                                                                                                                                    | `tests/lib/money.test.ts`                                       | Chat 3         |
| M8  | Supabase adapter          | `src/lib/sync/supabase-transport.ts` (+ internal `wire.ts`) | `SyncTransport` + 6 online functions                | is the production adapter at `SyncTransport`                                                                                            | `tests/lib/sync/wire.test.ts`; behaviour in pgTAP               | Chat 3         |
| M10 | Permissions               | `src/lib/permissions.ts`                                    | `may(action, role)`, `allowedWhenCompleted(action)` | none; the TS twin of `private.may()`                                                                                                    | `tests/lib/permissions.test.ts` + permission case table         | Chat 3         |
| M11 | Message history (slice 8) | `src/lib/sync/messages.ts`                                  | `syncMessages()`, `loadOlder()`, `trimCache()`      | **`MessageFeed`** (Supabase feed functions, fake); reuses `LocalTables`                                                                 | `tests/lib/sync/messages.test.ts`                               | Slice 8        |
| M9  | API v1                    | `src/server/api-v1/`                                        | `createApiV1({ store }) → handle(request)`          | **`ApiStore`** (`createPostgresApiStore`, `createMemoryApiStore`)                                                                       | `tests/api/v1.*.test.ts` through `handle`; store contract suite | Chat 3         |
| D1  | Push                      | `public.push_changes()`                                     | mutations JSON → `{ applied, rejected }`            | behind M8                                                                                                                               | pgTAP through `push_changes` + `pull_changes`                   | Chat 2         |
| D2  | Pull                      | `public.pull_changes()`                                     | cursors JSON → changes JSON                         | behind M8                                                                                                                               | pgTAP                                                           | Chat 2         |
| D3  | Shares in SQL             | `private.compute_shares()`                                  | items JSONB → shares                                | none; the SQL twin of M1's `computeShares`                                                                                              | Generated pgTAP from the shared case table                      | Chat 2         |
| D4  | Online functions          | `public.preview_invite()` … `revoke_api_token()`            | one function each                                   | behind M8                                                                                                                               | pgTAP, each through itself                                      | Chat 2         |
| D6  | Permissions in SQL        | `private.may()`, `private.require()`                        | action × role → allowed                             | none; the SQL twin of M10                                                                                                               | Generated pgTAP from the permission case table                  | Chat 2         |
| D5  | API SQL                   | `api.v1_*()`                                                | 4 functions, token hash first                       | the SQL half of M9's Postgres adapter                                                                                                   | pgTAP (security); the store contract suite (shapes)             | Chat 2         |

### 9.2 Seams and who owns them

There are four real seams in TypeScript in the MVP, and a fifth in slice 8 (`MessageFeed`). Across the TypeScript–SQL divide there are four **wire contracts**:
JSON shapes that one side writes and the other reads. This document fixes them, so chats 2 and 3 can build
their sides without waiting on each other.

| Seam or contract        | Kind              | Defined in                                    | Sides / adapters                                                                                              | Chat 2                                               | Chat 3                                                     |
| ----------------------- | ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `LocalTables`           | TS seam           | `src/lib/sync/local.ts`                       | `dexieTables(db)`; `createMemoryTables()` (`tests/support/memory-tables.ts`)                                  | —                                                    | Owns; reshapes it (M3)                                     |
| `SyncStore`             | TS seam           | `src/lib/sync/engine.ts`                      | `createDexieSyncStore()`; the fake store in `tests/lib/sync/engine.test.ts`                                   | —                                                    | Owns; **kept unchanged**                                   |
| `SyncTransport`         | TS seam           | `src/lib/sync/engine.ts`                      | `supabaseTransport`; the fake transport in `tests/lib/sync/engine.test.ts`                                    | —                                                    | Owns; **kept unchanged**                                   |
| `ApiStore`              | TS seam           | `src/server/api-v1/store.ts`                  | `createPostgresApiStore(sql)`; `createMemoryApiStore(fixture)`                                                | Writes the `api.v1_*` SQL the Postgres adapter calls | Owns the interface, both adapters and their contract suite |
| Mutation JSON           | Wire contract     | `src/lib/sync/types.ts`, spec "New mutations" | Device writes; `push_changes` reads                                                                           | Reads it exactly                                     | Writes it                                                  |
| Pull JSON               | Wire contract     | §11.2 (snake_case rows)                       | `pull_changes` writes; `wire.ts` reads                                                                        | Owns the shape                                       | Reads it                                                   |
| `api.v1_*` JSON         | Wire contract     | §11.2 (camelCase)                             | `api.v1_*` writes; `postgres-store.ts` reads                                                                  | Owns the shape                                       | Reads it                                                   |
| Ledger case table       | Shared fixture    | `tests/fixtures/ledger-cases.ts`              | `tests/lib/ledger.test.ts`; generated `supabase/tests/ledger_cases.test.sql`                                  | Creates it and the SQL generator                     | Runs `computeShares`/`summarizeGroup` against it           |
| Permission case table   | Shared fixture    | `tests/fixtures/permission-cases.ts`          | `tests/lib/permissions.test.ts`; generated `supabase/tests/permission_cases.test.sql`                         | Creates it and its generator                         | Runs `may()` against it                                    |
| `MessageFeed` (slice 8) | TS seam           | `src/lib/sync/messages.ts`                    | `supabaseMessageFeed` (calls `pull_messages`, `message_history`); a fake in `tests/lib/sync/messages.test.ts` | Writes the feed functions                            | Owns the interface and both adapters                       |
| HTTP `/api/v1`          | External contract | `docs/api-v1.openapi.yaml`                    | M9 writes; Pholio reads                                                                                       | —                                                    | Owns; contract tests                                       |

**Seams considered and not drawn** (one adapter each, so they would be indirection only):

- A seam for the online functions (`preview_invite`, `join_group`, …). Only Supabase implements them,
  their behaviour lives in SQL and is tested by pgTAP, and the client side is a call plus error mapping.
- A rate-limiter or token-store seam in the API. Both live inside `api.v1_*` (ADR-003), so the `ApiStore`
  seam already covers them.
- A clock or event-source seam in the sync controller. Nothing but the browser would fill it; the
  controller is checked by hand.
- A seam for the Realtime change signal (slice 8). Only Supabase Realtime fills it; the controller takes
  a `subscribe(groupIds, onSignal)` function as a dependency, and a missed signal only costs latency.
- A router or middleware seam in the API. There are five fixed routes; routing is part of the handler's
  implementation.

### 9.3 M1 Ledger (`src/lib/ledger.ts`)

One deep, pure module shared by the app and the API. Callers: the bill editor, the change planner (M2),
the Balances tab, Settle up, nudges (slice 8), and the API (M9).

**Interface:**

```ts
type Item = { id: string; description?: string; amountCents: number; paidBy: string; splitAmong: string[] };
type Share = { memberId: string; paidCents: number; owedCents: number; owedTo: Record<string, number> };
type LedgerMember = { id: string; displayName: string; hasLogin: boolean };
type LedgerEntry = {
	kind: "expense" | "payment";
	deletedAt: string | null;
	paymentStatus: "pending" | "confirmed" | "declined" | "undone" | null; // null for bills
	shares: Share[];
};
type EntryDraft = {
	kind: "expense" | "payment";
	description: string;
	amountCents: number;
	entryDate: string;
	notes: string | null;
	items: Item[] | null;
	shares: Share[];
};
type EntryProblem = { field: string; reason: string };
type Debt = { fromMemberId: string; toMemberId: string; amountCents: number }; // from owes to
type PersonSummary = {
	memberId: string;
	balanceCents: number;
	state: "owes" | "owed" | "settled";
};
type GroupSummary = { people: PersonSummary[]; debts: Debt[] };

function computeShares(items: Item[]): Share[];
function validateEntry(entry: EntryDraft, members: LedgerMember[]): EntryProblem[];
function summarizeGroup(entries: Iterable<LedgerEntry>, members: LedgerMember[]): GroupSummary;
```

- `computeShares`:
  - **Precondition:** items are well-formed, which `validateEntry` checks. That means at least one item,
    whole positive amounts, and a non-empty `splitAmong` with no repeats. If not, it throws `RangeError`:
    that is a programming error, not a user-facing problem.
  - **Result:** Σ paid = Σ owed = total, every owed ≥ 0, and each share's `owedTo` adds up to its owed
    (keys are payers; a payer's own part is included). The same items always give the same shares, in
    bill order.
  - **Payments:** a payment's shares are `computeShares([{ amountCents, paidBy: from, splitAmong: [to] }])`,
    so there is no separate payment function.
- `validateEntry`:
  - Returns `[]` when the entry would be accepted. Otherwise it returns one problem per failed check in the
    spec's "Entry checks on the server" `HS422` list, including "shares differ from `computeShares(items)`".
  - It never throws on bad input; problems are returned.
- `summarizeGroup`:
  - **Input:** every entry of the group. It skips deleted bills and every payment that isn't
    `confirmed` itself, so no caller has to filter (architecture review candidate 3). The API passes one
    synthetic confirmed entry holding SQL's per-member and per-pair totals; they are `Share`-shaped. Every
    `memberId` in the input must be in `members`, otherwise it throws `RangeError`.
  - **`debts`:** one per pair with a non-zero debt, netted both ways (spec "Debts"), sorted by debtor
    name then creditor name (case-insensitive, then id). Σ over a person of what they're owed − what they
    owe = their `balanceCents`.
  - **`people`:** everyone with a share, sorted by `displayName`. Σ `balanceCents` = 0.
  - Pending payments don't change anything here; screens read them from the entries directly ("Waiting
    for confirmation" in Settle up, the Confirm buttons on Balances).
- **Seam:** none. Every dependency is in-process, so there is nothing to swap. **Adapters:** none.
- **Depth and the deletion test:** three functions hide a lot:
  - the whole-number rounding per payer (lcm, `BigInt`, each payer absorbing, the negative fallback);
  - every `HS422` rule;
  - which entries count, and the pairwise netting with every tie-break.

  Delete the module, and rounding and debts reappear in the editor, the planner, nudges and the API,
  where they would drift apart.

- **Test surface:** `tests/lib/ledger.test.ts`, through these three functions only. It runs every case in
  the shared table (§9.13), the seeded invariants (§10.1), and one failing draft per `HS422` rule.
- **Runtime imports:** none, so the Vercel function can load it (ADR-001).

**Rounding (`computeShares`), exactly, for each payer `p` separately:**

1. `paid[m]` = Σ amounts of items `m` paid.
2. Take `p`'s items. Let `D` = lcm of their `splitAmong.length`. `num[m]` = Σ over `p`'s items that `m` is
   in of `amountCents × (D / n)`. All of this is `BigInt` in TypeScript and `NUMERIC` in SQL (`D` can
   exceed 2⁵³).
3. `part[m][p]` = ⌊(2·num[m] + D) / (2·D)⌋, i.e. `num/D` rounded half up.
4. `diff` = Σ amounts of `p`'s items − Σ `part[·][p]`. `part[p][p] += diff`, even if `p` is not in any of
   their own splits (Sam pays 1000 split by three others → Sam owes 1 to himself, which nets to nothing in
   debts).
5. If that would make `part[p][p]` negative, it goes to 0 and the remaining cents come off other people's
   parts of `p`, one cent each, largest rounding excess (`part·D − num`) first; ties go to **bill order**
   — the order in which members first appear scanning items in order and each `splitAmong` in order.
6. `owed[m]` = Σ over payers `part[m][p]`, and `owedTo[m]` = the non-zero `part[m][·]`. Result: one share
   per member who paid or is in any split (0/0 shares allowed), sorted by bill order with payers not in
   any split last.

**Debts (`summarizeGroup`):** for each pair (A, B): `Σ owedTo[A][B] − Σ owedTo[B][A]` over bills that
aren't deleted and confirmed payments. A positive result is A owing B.

### 9.4 M2 Change planner (`src/lib/changes.ts`)

This module turns an **intent** (what a person asks to do) into a **plan**, and **commits**
it on the device. It has two functions: `planChange`, which is pure, so every permission and validation
rule the device mirrors from the server is testable without Dexie; and `commit`, the only local writer,
which reads, plans, applies and queues in one transaction. It replaces the earlier `commitChange` +
`mutate()` pair, which read the group's state outside the write transaction: two quick taps in the
settle-up tracker (in the design of the day) could plan against the same balances and record the same
payments twice.

**Interface:**

```ts
type GroupState = {
	group: GroupRow;
	members: MemberRow[];
	entries: EntryRow[];
	conflicts: ConflictRow[];
	invites: InviteRow[];
	me: { memberId: string; userId: string; role: "owner" | "member" | "guest" } | null; // null: not in the group
};
type Intent = { type: "createGroup"; name: string; displayName: string } | ({ groupId: string } & GroupIntent);
type GroupIntent =
	| { type: "renameGroup"; name: string }
	| { type: "deleteGroup" }
	| { type: "addPerson"; displayName: string }
	| { type: "renamePerson"; memberId: string; displayName: string }
	| { type: "removePerson"; memberId: string } // yourself = leave
	| { type: "addExpense"; draft: ExpenseDraft }
	| { type: "editExpense"; entryId: string; draft: ExpenseDraft }
	| { type: "recordPayment"; from: string; to: string; amountCents: number; entryDate: string; notes: string | null }
	| { type: "confirmPayment"; entryId: string }
	| { type: "declinePayment"; entryId: string; note: string | null }
	| { type: "undoPayment"; entryId: string }
	| { type: "deleteEntry"; entryId: string }
	| {
			type: "resolveConflict";
			conflictId: string;
			resolution: "kept_current" | "took_proposed" | "merged";
			final: ExpenseDraft | "deleted";
	  }
	| { type: "completeGroup" }
	| { type: "reopenGroup" }
	| { type: "createInvite"; claimMemberId: string | null }
	| { type: "revokeInvite"; inviteId: string }
	// slice 8 (docs/chat-spec.md):
	| { type: "sendMessage"; body: string; replyToId: string | null }
	| { type: "deleteMessage"; messageId: string }
	| { type: "pinMessage"; messageId: string; pinned: boolean }
	| { type: "nudge"; memberId: string };
type Plan =
	| { ok: true; mutations: Mutation[]; createdId: string | null } // the new group, entry or invite
	| { ok: false; code: "HS403" | "HS409" | "HS422"; reason: string };

function planChange(
	state: GroupState | null, // null only for createGroup
	intent: Intent,
	ctx: { newId(): string; randomToken(): string; now: string; today: string; isAnonymous: boolean }
): Plan;

function createCommitter(deps: {
	db: LocalDb;
	userId: string;
	isAnonymous: boolean;
	requestSync(): void;
	newId(): string;
	randomToken(): string;
	now(): Date;
}): (intent: Intent) => Promise<Plan>; // commit
function useCommit(): (intent: Intent) => Promise<Plan>; // from React context
```

- **Invariants:**
  - `planChange` is pure: the same inputs give the same plan.
  - Its permission checks ask M10 `may()` (spec decision 8) and its validation follows `validateEntry`
    (M1). Both use the server's codes, so the device refuses exactly what `push_changes` would.
  - `baseVersion` comes from the entry's `rowVersion` in `state`.
  - Shares come from `computeShares`; a payment's default amount and a nudge's amount come from
    `summarizeGroup`'s debts.
  - `recordPayment` plans a payment that counts at once when the other side has no login (or neither side
    has one and you are a full member), and a pending one otherwise.
- **Ordering:** mutations come back in the order they must be applied.
- **Error modes:** refusals are returned (`ok: false`), never thrown.
- **Idempotent answers:** confirming, declining or undoing a payment this device already shows as
  answered plans `ok: true` with no mutations, so a double tap is invisible. `recordPayment` is refused
  (`HS409`) while the same pair already has a pending payment, so a double tap can't record it twice.
- **`commit(intent)`**, built once per signed-in session by `createCommitter`:
  - **One Dexie read-write transaction** over every table: read the whole group named by
    `intent.groupId` (none for `createGroup`) into `GroupState`, with `me` from the member row for
    `userId` plus `isAnonymous`; `planChange`; then for each mutation, in order, `applyMutation` (M3) and
    `outbox.add`. Nothing inside awaits anything but Dexie, so the transaction stays open.
  - After the transaction commits, `requestSync()`, only if at least one mutation was queued.
  - Returns the `Plan`, so the screen can show `reason` or use `createdId` (open the new group or entry,
    share the new invite; its token is in `inviteTokens` by `inviteId`).
  - **Storage failures** (quota full, IndexedDB closed or blocked) throw and roll the transaction back;
    the signed-in layout shows "Couldn't save on this device". Screens branch only on `Plan`.
  - **Wiring:** the signed-in layout builds the committer and provides it through React context; it
    rebuilds it when the user id or `isAnonymous` changes (a guest adding their email).
  - **Server side unchanged:** `push_changes` still accepts or rejects each mutation on its own. If a
    commit's mutations are partly rejected, the next pull shows the true state and the rejection toast
    explains it.
- **Invite tokens:** the token travels inside `invite.create`, and `applyMutation` (M3) stores it in
  `inviteTokens`. The planner stays pure.
- **Seam:** none. `ctx` and `createCommitter`'s `deps` are how it accepts its dependencies (database,
  ids, randomness, time, sync) instead of creating them. IndexedDB is local-substitutable
  (`fake-indexeddb`), so tests run the real Dexie code rather than a second adapter.
- **Deletion test:** without this module, every screen would build its own mutations, permissions, shares
  and settle-up expansion, and would have to get the transaction right. Folded in: the per-area action
  files from the earlier draft (each a pass-through), today's `createGroup` and `renameGroup` from
  `groups.ts`, and `src/lib/sync/mutate.ts`, which is deleted.
- **Reads:** the hooks (`useGroups`, `useEntries`, …) stay as thin per-area read files. They are
  `useLiveQuery` plus the alphabetical sort, so they have no logic to test and no seam.
- **Test surface:**
  - `tests/lib/changes.test.ts`, through `planChange` with plain `GroupState` objects: the role matrix from
    spec decision 8, one row per intent; each intent's mutations; each refusal; idempotent answers.
  - `tests/lib/changes.commit.test.ts`, through `commit`, built with a `LocalDb` on `fake-indexeddb` and a
    `requestSync` spy: two taps on Record payment queue one payment; a failing write rolls back both the
    rows and the outbox; the outbox holds a commit's mutations in plan order; `requestSync` runs only when
    something was queued; `createdId` names the new row.

### 9.5 M3 Local replica (`src/lib/sync/local.ts`)

**Interface:**

```ts
function applyMutation(tables: LocalTables, mutation: Mutation, userId: string): Promise<void>;
function mergePull(tables: LocalTables, pull: PullResult, pending: Mutation[], userId: string): Promise<void>;
```

- **Invariants of `applyMutation`:** it shows the server's effect locally, closely enough to display, and
  never invents server-only fields. For a create, if the row is already there the server's copy wins and
  nothing happens.
- **Invariants of `mergePull`:**
  - It drops groups missing from `pull.groupIds` (except unsynced creates) together with all their
    children.
  - It puts server rows, replacing each entry whole with its items and shares, and sets cursors.
  - Then it replays `pending`, except stale `entry.update` and `entry.delete` changes made by someone else
    (§4.2).
- **Ordering:** the caller must read `pending` in the same transaction as the merge (`createDexieSyncStore`
  does).
- **Seam: `LocalTables`** (real). Its adapters are `dexieTables(db)` and `createMemoryTables()`. Chat 3
  reshapes it to stay small as tables are added, so it doesn't grow one method per table:

  ```ts
  interface Rows<T> {
  	get(id: string): Promise<T | undefined>;
  	byGroup(groupId: string): Promise<T[]>;
  	put(rows: T[]): Promise<void>;
  	delete(ids: string[]): Promise<void>;
  }
  interface LocalTables {
  	groups: Rows<GroupRow>;
  	members: Rows<MemberRow>;
  	entries: Rows<EntryRow>;
  	conflicts: Rows<ConflictRow>;
  	invites: Rows<InviteRow>;
  	inviteTokens: Rows<InviteTokenRow>;
  	cursors: Rows<CursorRow>;
  	groupIds(): Promise<string[]>;
  }
  ```

- **Locality of the reshape:** the "drop a gone group and its children" rule moves out of the adapters
  (today's `keepOnlyGroups`) into `mergePull`, so it lives once. The memory adapter is one generic
  `Rows<T>` over a `Map`, and the Dexie adapter is one line per table.
- **Test surface:** `tests/lib/sync/local.test.ts` and `merge.test.ts`, through `applyMutation` and
  `mergePull` on the memory adapter.
- **Optional:** a small `Rows` contract suite run against both adapters (Dexie through `fake-indexeddb`).
  It would hold the Dexie adapter to the same interface.

### 9.6 M4 Sync engine (`src/lib/sync/engine.ts`, exists)

**Interface:** `syncOnce(store: SyncStore, transport: SyncTransport): Promise<{ pushed: number; rejected: RejectedMutation[] }>`.

- **Ordering:** it pushes pending mutations in order, in batches of 50, removing each batch's applied and
  rejected ids before sending the next. Then it pulls once with the current cursors and hands the result
  to `store.applyPull`.
- **Error modes:** any store or transport failure throws, and mutations not yet acknowledged stay queued.
  Rejections are returned, not thrown.
- **Seams: `SyncStore` and `SyncTransport`.** Both are real and both are **kept unchanged**:

  | Seam            | Production adapter                                    | Test adapter                                         |
  | --------------- | ----------------------------------------------------- | ---------------------------------------------------- |
  | `SyncStore`     | `createDexieSyncStore(db, userId)` (`dexie-store.ts`) | `fakeStore()` in `tests/lib/sync/engine.test.ts`     |
  | `SyncTransport` | `supabaseTransport` (`supabase-transport.ts`)         | `fakeTransport()` in `tests/lib/sync/engine.test.ts` |

- **Leverage:** all seven slices change the data inside `Mutation` and `PullResult`, not the engine.
  Neither seam gains a method.
- **Test surface:** `tests/lib/sync/engine.test.ts`.

### 9.7 M5 Sync controller, M7 Money

(M6, the local writer `mutate()`, was folded into M2's `commit` after the architecture review on
2026-11-04.)

- **M5 `controller.ts` (exists):**
  - **Interface:** `startSync(store, transport, onRejected) → stop`, `requestSync()`, `useSyncStatus()`.
  - **Invariants:** one run at a time; a request during a run causes exactly one more run; offline means
    the status says offline and no attempt is made.
  - **Dependencies:** it accepts `store` and `transport` but reads `window`, `document` and `navigator`
    directly. No seam is drawn there (see §9.2), and it is checked by hand.
  - **Deletion test:** delete it, and the scheduling would spread into the layout.
- **M7 `money.ts`:**
  - **Interface:** `parseAmount(input): number | null` and `formatAmount(cents): string`. It is pure and
    tested through those two functions.

### 9.8 M8 Supabase adapter (`src/lib/sync/supabase-transport.ts`)

- **What it is:** the production adapter at the `SyncTransport` seam, and the only file that talks to
  Supabase about data.
- **Online functions:** it also exports `previewInvite`, `joinGroup`, `upgradeGuest`, `createApiToken`,
  `listApiTokens` and `revokeApiToken` as plain functions. Each throws `TransportError { code, message }`
  with the SQLSTATE as `code`.
- **Callers:** screens call the online functions directly, then `requestSync()` after `joinGroup` and
  `upgradeGuest`. There are no wrapper modules, which would be pass-through.
- **`wire.ts`:** the adapter's pure internal half (snake_case pull rows → device rows).
  `tests/lib/sync/wire.test.ts` is the adapter's test surface. The network half is covered by pgTAP on the
  SQL it calls, and by hand.

### 9.9 M9 API v1: designing the interface twice

The handler has to satisfy these constraints:

- It turns an HTTP `Request` into a `Response` that matches the OpenAPI contract.
- Exactly one database call per request (ADR-003).
- It computes balances and debts with M1.
- It can be tested with no database.

Its dependencies are Postgres, which is local-substitutable (a `postgres` client against the local
Supabase), and the clock. Three interfaces were sketched.

**A. One entry point, a store seam at the SQL calls.**

```ts
const handle = createApiV1({ store, now }); // (request: Request) => Promise<Response>
```

- Everything HTTP lives behind `handle`: routing, the token format and hash, params, cursor encoding,
  status codes, headers, CORS and JSON shaping.
- The `ApiStore` seam has four methods, one per `api.v1_*` function. Authentication and the rate limit are
  part of the store's contract.

**B. A router with middleware and fine-grained store methods.**

```ts
const app = router().use(cors(), auth(tokenStore), rateLimit(limiter)).get("/groups/:id", groupHandler(groupStore));
```

- Tokens, rate limits, groups, shares and entries each get their own store interface.
- Flexible, but the interface is the union of every middleware and store. Each store method is a separate
  round trip, auth and rate limiting move into TypeScript (breaking ADR-003), and the `limiter` and
  `tokenStore` seams would each have one adapter.

**C. Typed endpoint functions, with HTTP in the Vercel adapter.**

```ts
const api = createApiV1Service(store);
api.getGroup(tokenHash, groupId); // Promise<Result<GroupDetail, ApiError>>
```

- The common caller gets typed results and errors.
- But the status codes, headers, cursor encoding and token parsing that Pholio relies on would sit in the
  Vercel adapter, outside the module. Contract tests would have to test that adapter separately: two test
  surfaces, with the most important behaviour outside the deep module.

**Comparison:**

|                | A                                                             | B                                           | C                                               |
| -------------- | ------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| Depth          | Highest: one function hides all HTTP and shaping              | Low: callers compose middleware and stores  | Medium: hides shaping, not HTTP                 |
| Locality       | A contract change touches one module                          | Spread across middleware, stores and routes | Split between the service and the adapter       |
| Seam placement | At the SQL calls, where two adapters exist (Postgres, memory) | Several seams, most with one adapter        | At the store; HTTP left without a seam or tests |
| Test surface   | `handle(request)`: the same call Vercel makes                 | Each middleware, plus integration           | The service, plus the adapter separately        |

**Chosen: A.** It is the deepest, it keeps a contract change local to one module, and its only seam is the
one with two real adapters. From C it borrows typed results at the store boundary (`ApiStore` returns typed
rows or throws `ApiStoreError`).

### 9.10 M9 API v1: the chosen interface (`src/server/api-v1/`)

```ts
function createApiV1(deps: { store: ApiStore }): (request: Request) => Promise<Response>;
```

- **Order of checks:**
  1. `OPTIONS` → 204.
  2. A method other than `GET` → 405.
  3. An unknown route → 404.
  4. A missing or malformed bearer token → 401.
  5. Bad params → 400.
  6. One store call; then `ApiStoreError` maps `HS401` → 401, `HS404` → 404 and `HS429` → 429 (with
     `Retry-After` from the error's `retryAfterSeconds`, which the Postgres store reads from `HS429`'s
     `DETAIL`; 60 if missing). The handler needs no clock.

  Steps 1–5 never touch the store.

- **Invariants:** it never throws. Anything unexpected is a 500 `server_error`, logged without the token
  or its hash. Every response carries the headers in §10.2. Bodies match `docs/api-v1.openapi.yaml`.
  The person's `debts` and `balanceCents` come from `summarizeGroup` (M1), filtered to the person. Timestamps go through `toISOString()`.
- **Implementation (not interface):** `http.ts` (JSON, errors, headers), `cursor.ts` and `token.ts` are
  internal files with no tests of their own. Tests reach them through `handle`.
- **Composition root:** `api/v1/[...path].ts` creates the `postgres` client and the Postgres store once per
  instance, and exports `GET`, `OPTIONS`, `POST`, `PUT`, `PATCH` and `DELETE`, all delegating to `handle`.
  It has no logic, so it has no tests; `bunx vercel build` proves it bundles.
- **Test surface:** `handle(request)` with the memory store:
  - `tests/api/v1.handler.test.ts`: behaviour and error mapping;
  - `tests/api/v1.contract.test.ts`: every response against the OpenAPI document with closed schemas, plus
    the golden JSON.

  The contract tests therefore need no database.

### 9.11 The `ApiStore` seam

```ts
interface ApiStore {
	me(tokenHash: string): Promise<MeRow>;
	groups(tokenHash: string): Promise<GroupRowApi[]>;
	group(tokenHash: string, groupId: string): Promise<GroupDetailRow>; // members with paid/owed totals
	payments(
		tokenHash: string,
		query: { groupId: string | null; cursor: Record<string, number>; limit: number }
	): Promise<{
		payments: PaymentRowApi[];
		cursor: Record<string, number>;
		hasMore: boolean;
		removedGroupIds: string[];
	}>;
}
class ApiStoreError extends Error {
	code: "HS401" | "HS404" | "HS429";
	retryAfterSeconds: number | null; // HS429 only
}
```

**Interface invariants**, which both adapters must honour:

- Every call authenticates `tokenHash` and counts once against the token's 60-a-minute window. Calls
  refused with `HS429` don't count.
- A call returns only the token owner's data, read from one snapshot.
- `HS404` means a group that is unknown, deleted or not the owner's.
- In `payments`, only payments that involve the owner and count are returned; a page never splits a group version and may exceed `limit` to finish one. A fully read
  group's cursor value is its head version. `removedGroupIds` lists cursor groups that are no longer
  accessible, and those groups are left out of the returned cursor.
- Row shapes are the `api.v1_*` JSON in §11.2.

**Adapters:**

| Adapter                         | Where                                 | Implementation                                                                                                                                                          |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPostgresApiStore(sql)`   | `src/server/api-v1/postgres-store.ts` | One `SELECT api.v1_*(…)` per method; maps SQLSTATE, and a NULL from `v1_group`/`v1_payments`, to `ApiStoreError`. A small adapter over a large SQL implementation (D5). |
| `createMemoryApiStore(fixture)` | `tests/support/memory-api-store.ts`   | Holds tokens (by hash), groups, members, payments that count and versions in memory and applies the same invariants, including the rate window.                         |

**One contract suite holds both adapters to the interface:** `tests/api/store.contract.ts` exports
`describeApiStore(name, makeStore)`, which seeds the same scenario through each adapter and asserts the
invariants above.

- `tests/api/memory-store.test.ts` runs it on every `bun test`.
- `tests/api/postgres-store.test.ts` runs it with `bun run test:api-db`. That run seeds through
  `push_changes` and `create_api_token`, and skips itself without `HANDSHAKE_API_DATABASE_URL`.

If the fake and Postgres ever disagree, this suite is what fails.

### 9.12 D1–D5 Database modules (chat 2)

- **D1 `push_changes(p_mutations JSONB)`:**
  - **Interface:** the `Mutation` JSON union in, and `{ applied: [id], rejected: [{ id, code, reason }] }`
    out.
  - **Invariants:** exactly once per mutation id; one savepoint per mutation; mutations applied in array
    order; every write stamped with the group's next version.
  - **Error modes:** the `HS` codes from §11.1. The whole call fails only when the caller isn't signed in.
  - **Implementation (internal, no seam):** the dispatcher, `private.apply_*`, `require_member` and
    `validate_entry`.
  - **Test surface:** pgTAP **through `push_changes`** as a signed-in test user, asserting on what
    `pull_changes` returns and on table rows. Tests never call `private.apply_*` directly, so the internals
    can be reorganised freely.
- **D2 `pull_changes(p_cursors JSONB)`:**
  - **Invariants:** one snapshot; each group's version matches the rows returned with it; children travel
    with their entry; never `token_hash`.
  - **Test surface:** pgTAP, including the exact key set of each row type in §11.2. Those are the keys
    `wire.ts` reads.
- **D3 `private.compute_shares(p_items JSONB)`:**
  - **What it is:** the SQL twin of M1's `computeShares`. It is a module of its own, not just part of D1,
    because it has an interface that must agree with another.
  - **Test surface:** the generated case table (§9.13). Beyond that, D1's tests check that it is enforced:
    shares that match are accepted, and shares one cent off are rejected with `HS422`.
- **D4 online functions** (`preview_invite`, `join_group`, `upgrade_guest`, `create_api_token`,
  `list_api_tokens`, `revoke_api_token`): each is a small module tested through itself in pgTAP, as each
  caller (`anon` or `authenticated`) would call it.
- **D5 `api.v1_*`:** the SQL half of the Postgres `ApiStore` adapter.
  - pgTAP covers security: hashing, `HS401` and `HS429`, owner-only data, and `handshake_api`'s reach.
  - The store contract suite (§9.11) covers the shapes and paging, through `postgres-store.ts`.

### 9.13 One table of pinned cases for TypeScript and SQL

`computeShares` (M1) and `private.compute_shares` (D3) must give the same cents for the same bill. One
hand-written table keeps them in step:

- **The table:** `tests/fixtures/ledger-cases.ts` exports
  `LEDGER_CASES: { name, members: string[], items: { amountCents, paidBy, splitAmong }[], paid, owed,
parts, balances, debts }[]`, with people by name and expected values worked out by hand. It starts with
  every case in the spec's Testing Checklist: Scenario A, the $10 and $20 splits by three, Scenarios B and
  C, several payers with and without a cent, the payer not sharing, and two items of 1000. New cases are
  only ever added here.
- **TypeScript side:** `tests/lib/ledger.test.ts` loops over the table, comparing `computeShares` with
  `paid`/`owed`/`parts`, and `summarizeGroup` with `balances`/`debts`.
- **SQL side:** `scripts/ledger-cases-sql.ts` renders the table into `supabase/tests/ledger_cases.test.sql`.
  That file holds one pgTAP `results_eq` per case against `private.compute_shares`, with names mapped to
  fixed UUIDs. `bun run gen:ledger-cases` writes it.
- **Drift guard:** `tests/lib/ledger-cases-sql.test.ts` renders the table again in memory and fails if the
  file on disk differs. Editing the table without regenerating breaks `bun test`, and breaking either
  implementation breaks its own suite.

The generator only formats; it computes nothing, so the expected values stay hand-worked as `AGENTS.md`
requires. Chat 2 creates the table, the generator, the generated file and the drift guard, because
`compute_shares` is built first. Chat 3's ledger tests run on the same table.

### 9.14 M10 Permissions (`src/lib/permissions.ts`)

**Interface:**

```ts
type Role = "owner" | "member" | "guest";
type Action =
	| "group.rename"
	| "group.delete"
	| "group.complete"
	| "group.reopen"
	| "member.add"
	| "member.rename.self"
	| "member.rename.others"
	| "member.remove.self"
	| "member.remove.others"
	| "entry.create"
	| "entry.update"
	| "entry.delete.own"
	| "entry.delete.others"
	| "conflict.resolve"
	| "invite.create"
	| "invite.revoke.own"
	| "invite.revoke.others"
	| "payment.record.own"
	| "payment.record.others"
	| "payment.respond"
	| "payment.undo"
	// slice 8:
	| "message.send"
	| "message.delete.own"
	| "message.pin"
	| "nudge.send";

function may(action: Action, role: Role): boolean;
function allowedWhenCompleted(action: Action): boolean;
```

- **Invariants:** it is the spec's decision 8 table (plus the chat rows in `docs/chat-spec.md`), nothing
  more. Working out _which_ action an intent is (your own entry or someone else's, yourself or another
  person) is the caller's job: `planChange`, or a screen deciding whether to show a button.
- **Seam:** none. Its twin is D6 `private.may()` in SQL; the permission case table (ADR-007) holds the two
  in step.
- **Deletion test:** delete it, and every screen and `planChange` re-derive the matrix; the drift ADR-007
  exists to prevent.
- **Test surface:** `tests/lib/permissions.test.ts` loops over `tests/fixtures/permission-cases.ts`.

### 9.15 M11 Message history and live signals (slice 8)

**Interface** (`src/lib/sync/messages.ts`):

```ts
interface MessageFeed {
	pull(
		groupId: string,
		since: number,
		limit: number
	): Promise<{ messages: MessageRow[]; version: number; gap: boolean }>;
	history(groupId: string, beforeSeq: number, limit: number): Promise<MessageRow[]>;
}
function syncMessages(
	tables: LocalTables,
	feed: MessageFeed,
	groups: { groupId: string; messageVersion: number }[]
): Promise<void>;
function loadOlder(
	tables: LocalTables,
	feed: MessageFeed,
	groupId: string
): Promise<{ loaded: number; atStart: boolean }>;
function trimCache(tables: LocalTables, keep: number): Promise<void>; // 500, at app start
```

- **Invariants:** `syncMessages` runs after `pull_changes` in a sync, only for groups whose
  `message_version` is past the device's message cursor; it moves the cursor only after writing the
  messages; a `gap` drops the group's older cached messages first. `loadOlder` never moves the cursor.
  `trimCache` keeps each group's newest `keep` messages plus every message still waiting to send.
- **Seam: `MessageFeed`** (real): `supabaseMessageFeed` in `supabase-transport.ts` (calling
  `pull_messages` and `message_history`) and a fake in `tests/lib/sync/messages.test.ts`. Local storage
  goes through the existing `LocalTables` seam, which gains `messages`, `messageCursors`, `nudges` and
  `chatReads` rows.
- **Live signals:** `supabase-transport.ts` also exports `subscribeToGroups(groupIds, onSignal) →
unsubscribe`, Supabase Realtime private channels `group:<id>`. `startSync` takes it as a dependency and
  calls `requestSync()` on every signal, resubscribing when the group list changes or the app returns to
  the foreground. No seam is drawn (§9.2): only Realtime fills it, and a missed signal only costs latency.
- **Test surface:** `tests/lib/sync/messages.test.ts`, through the three functions with the fake feed and
  memory tables.

## 10. Testing strategy

| Layer               | Tool                                        | Lives in                                                                                 | Proves                                                                                                                                                        |
| ------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 ledger, M7 money | `bun test`                                  | `tests/lib/ledger.test.ts`, `money.test.ts`                                              | The shared case table (§9.13), invariants over seeded random bills, one draft per `HS422` rule                                                                |
| M2 change planner   | `bun test` (+ `fake-indexeddb`)             | `tests/lib/changes.test.ts`, `changes.commit.test.ts`                                    | Role matrix per intent, each intent's mutations, each refusal; `commit` is atomic and idempotent under double taps                                            |
| M3, M4, M8 sync     | `bun test` with memory tables and fakes     | `tests/lib/sync/*.test.ts`                                                               | `applyMutation` per type, `mergePull` (shares replaced, stale updates not replayed, dropped groups take their children), engine order, wire mapping           |
| D1–D5 SQL           | pgTAP                                       | `supabase/tests/*.test.sql`                                                              | Generated case table through `compute_shares`; each mutation through `push_changes`; conflicts; invites; completing; API security and `handshake_api`'s reach |
| Case-table drift    | `bun test`                                  | `tests/lib/ledger-cases-sql.test.ts`                                                     | The generated pgTAP file matches the case table                                                                                                               |
| M9 through `handle` | `bun test` + memory store                   | `tests/api/v1.handler.test.ts`                                                           | Auth header and token format, routing, params, error mapping (SQLSTATE → HTTP), balances and debts, headers                                                   |
| M9 contract         | `bun test` + Ajv                            | `tests/api/v1.contract.test.ts`                                                          | Every response validates against `docs/api-v1.openapi.yaml` with closed schemas; golden JSON for the pinned examples                                          |
| `ApiStore` adapters | `bun test` (memory always; Postgres opt-in) | `tests/api/store.contract.ts` run by `memory-store.test.ts` and `postgres-store.test.ts` | Both adapters honour the seam's invariants (§9.11); the Postgres run skips without `HANDSHAKE_API_DATABASE_URL`                                               |
| Guards              | `bun test`                                  | `tests/server/import-paths.test.ts`                                                      | No runtime `@/` imports in the function's import graph                                                                                                        |
| By hand             | Browser, 375 px and 1440 px                 | Spec "By hand" list                                                                      | Offline and back online, two browsers, guests, tokens (once screens exist)                                                                                    |

### 10.1 Shared numbers

The pinned cases live once, in `tests/fixtures/ledger-cases.ts`, and both implementations are tested
against that table (§9.13). Expected values are worked out by hand in the spec, never computed by the code
under test.

Invariant tests use a fixed-seed PRNG (no new dependency): 1 000 random bills of 1–8 items, 1–6 members,
amounts 1–100 000 cents. For each: Σ paid = Σ owed = total, owed ≥ 0, every share other than the
absorber's is within 1 cent of its exact share, and the same items always give the same shares. For
debts: each person's debts net to their balance.

### 10.2 Contract tests pin what Pholio relies on

- Field names, types and required fields of every response and of the error body.
- Status codes: 200, 400 `bad_request`, 401 `invalid_token`, 404 `not_found`, 405 `method_not_allowed`,
  429 `rate_limited`, 500 `server_error`.
- Headers: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, CORS headers,
  `Retry-After` on 429.
- Golden JSON: `GET /groups/{id}` for Sam after the $10 dinner and Alex's confirmed 333 (balance 333, one
  debt: Jo owes Sam 333) and `GET /payments` (one `received` payment), byte-for-byte after sorting keys.
- A change that fails a contract test is either a bug or a contract change. A contract change within v1 is
  additive only (`docs/api-v1.md`, Versioning) and updates the YAML in the same commit.

### 10.3 Commands

`bun test` runs all Bun tests (the Postgres store suite skips itself without its env var). `bun run test:db`
runs pgTAP. Chat 2 adds `bun run gen:ledger-cases`. Chat 3 adds `bun run test:api-db`
(`HANDSHAKE_API_DATABASE_URL=… bun test tests/api/postgres-store.test.ts`) and `bun run api:lint`
(`bunx @redocly/cli lint docs/api-v1.openapi.yaml`).

## 11. Handoff to chat 2 (database)

Read first: `AGENTS.md` (Database rules), the spec's Design Decisions, Data Model, Sync Changes and Testing
Checklist (Database), and §§4–5 and 9 here. Chat 2 builds modules D1–D5 and owns the SQL side of the wire
contracts in §9.2. Write SQL plus the shared case table, its generator and its drift test (§9.13); don't
touch `src/`. Test each module through its own interface: mutations through `push_changes` (never by
calling `private.apply_*`), rounding through the generated case table. Each migration is additive and
safe to re-run (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`, `DROP CONSTRAINT IF EXISTS`
then `ADD`), revokes from `PUBLIC, anon` and grants explicitly, and stamps every write with
`private.next_group_version()`.

### 11.1 Conventions for every migration

- **Rejections.** Raise with `USING ERRCODE`: `HS403` not allowed, `HS404` not found, `HS409` already
  resolved, `HS422` invalid. `push_changes()` returns `{ "id", "code", "reason" }` per rejection, with
  `code` = `SQLSTATE` and `reason` = `SQLERRM`. Other errors (e.g. `23514` check violations) pass through
  with their own SQLSTATE. Unknown mutation types are `HS422`.
- **Dispatch.** `private.apply_mutation(p_user, p_mutation)` looks at `type` and calls
  `private.apply_<type with . replaced by _>(p_user, p_mutation)`, e.g. `private.apply_entry_create`.
- **Shared checks** (create in 004, extend later with `CREATE OR REPLACE`):
  - `private.is_anonymous() RETURNS BOOLEAN`: `COALESCE((auth.jwt()->>'is_anonymous')::BOOLEAN, FALSE)`.
  - `private.caller_member(p_user UUID, p_group_id UUID) RETURNS public.group_members`: the caller's
    active row, or NULL.
  - `private.require_member(p_user, p_group_id, p_roles TEXT[]) RETURNS public.group_members`: raises
    `HS403` if no active row, the role is not in `p_roles`, or the group is deleted (008 adds: or
    completed, unless the mutation is `group.reopen` or `group.delete`).
- **JSON.** Mutations arrive camelCase (they are `src/lib/sync/types.ts`). Pull rows go out snake_case like
  today; JSON stored inside a row (`items`, conflict `base`/`proposed`) stays camelCase as the device wrote
  it.
- **Snapshots.** An `EntrySnapshot` is `{ "description", "amountCents", "entryDate", "notes", "items",
"shares": [{ "memberId", "paidCents", "owedCents" }], "deletedAt", "rowVersion", "updatedByMemberId" }`.
  `ledger_entry_versions.snapshot` and `entry_conflicts.base` use it; `entry_conflicts.proposed` uses it
  without `rowVersion`/`updatedByMemberId` (NULL for a delete).

### 11.2 Migrations

**`004_people.sql`**

- `group_members.role` check → `('owner', 'member', 'guest')`; add `joined_at TIMESTAMPTZ` (backfill
  `created_at` where `user_id IS NOT NULL`).
- `push_changes()` rejection shape with `code`; the existing `group.rename` membership check becomes
  `HS403`; `group.rename` is owner-only.
- Split `apply_mutation()` into the dispatcher plus `apply_group_create`, `apply_group_rename`.
- `group.create`: rejected `HS403` for anonymous callers; stores `baseCurrency` if sent, else the column
  default (the device stops sending it); sets the owner's `joined_at`.
- New: `apply_member_add` (owner; `user_id` NULL, role `member`), `apply_member_rename` (yourself, or the
  owner for anyone), `apply_member_remove` (the owner removes anyone else; anyone removes themselves =
  leave; soft delete; the owner leaving hands over to the earliest-joined active `member`, else soft-deletes
  the group), `apply_group_delete` (owner; soft delete).
- `pull_changes()`: members gain `joined_at`.
- Tests: `supabase/tests/people.test.sql` (spec's Roles case: a member can't add or
  remove others, rename others or the group; the owner leaving passes ownership to the earliest member;
  the last full member leaving deletes the group even with guests left; anonymous can't create groups).
  Update `supabase/tests/sync.test.sql` for the new rejection shape.
- **As built:**
  - The dispatcher is generic. A `type` matching `^[a-z]+\.[a-z]+$` runs `private.apply_<area>_<verb>(uuid,
jsonb)` when that function exists, else `HS422 Unknown change type: …`. Later migrations only add
    functions. Internal helpers are never named `apply_*`.
  - `require_member(p_user, p_group_id, p_roles TEXT[], p_allow_completed BOOLEAN DEFAULT FALSE)` has its
    fourth parameter from 004; 008 gives it meaning. It first locks the group row (`FOR NO KEY UPDATE`), so
    changes to one group apply one at a time and every check sees the last commit.
  - The new owner is the active `member` row with a user that joined first (`joined_at`, then `id`);
    non-members and guests never inherit. The leaving owner's removed row becomes role `member`, so a group
    has one `owner` row.
  - `member.rename` or `member.remove` of an id not in the group: `HS422`. Removing someone already
    removed: accepted, does nothing, takes no version. The owner may rename someone who left.
  - Every change in a deleted group is `HS403`, `group.delete` included. A deleted group stays in
    `pull_changes().group_ids` for whoever is still in it, with the group row's `deleted_at` set.
  - Every migration ends with `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon,
authenticated`, and 004 revokes `PUBLIC`'s default `EXECUTE` on future `private` functions.
  - `people.test.sql` gets its guests through `join_group` (007), so it needs the whole schema, as every
    test file does after `db reset`.

**`005_ledger.sql`**

- `ledger_entries` (including `recorded_via TEXT NULL CHECK (recorded_via = 'settle_up')`) and
  `ledger_shares` as in the spec's Data Model; RLS policy, `SELECT` grant, indexes.
- `private.compute_shares(p_items JSONB) RETURNS TABLE (member_id UUID, paid_cents BIGINT, owed_cents
BIGINT)` implementing §9 exactly, in `NUMERIC`.
- `private.validate_entry(p_group_id UUID, p_entry JSONB)`: every `HS422` check in the spec's "Entry checks
  on the server"; items ≤ 50, item description ≤ 60, `description` 1–120, `notes` ≤ 1000, amounts
  1…10¹².
- `apply_entry_create` (any active member including guests; `recordedVia` only by the owner),
  `apply_entry_update` (owner, member; no conflict branch yet: applies), `apply_entry_delete` (owner,
  member; guests only entries whose `created_by_member_id` is theirs). Update or delete of an id the server
  has never stored: accepted, does nothing. Each write replaces the entry's shares and stamps one version.
- `pull_changes()`: `entries`, each with its `shares` array (`member_id`, `paid_cents`, `owed_cents`).
- Shared case table (§9.13), made before `compute_shares`: `tests/fixtures/ledger-cases.ts`,
  `scripts/ledger-cases-sql.ts`, `package.json` script `gen:ledger-cases`, the generated
  `supabase/tests/ledger_cases.test.sql`, and `tests/lib/ledger-cases-sql.test.ts` (the drift guard).
- Tests: `supabase/tests/ledger.test.sql`, through `push_changes`: shares matching `compute_shares` are
  accepted and one cent off gives `HS422`; each other `HS422`; guests' delete rule; a deleted entry pulls
  with `deleted_at`; the exact key set of a pulled entry and share.
- **As built:**
  - Two table checks back the entry checks up: `items` is set exactly for expenses, and `recorded_via` only
    on payments. `ledger_shares` names its member as `(group_id, member_id)` → `group_members (group_id,
id)` (a new unique index), so a share can't point at someone from another group.
  - `compute_shares` is `IMMUTABLE` and returns shares in bill order; the generated tests check the order.
  - `validate_entry` also checks:
    - Members who left still count as in the group, so old bills stay valid. Ids are compared as text, so
      something that isn't an id is `HS422`, not a cast error.
    - `description` is text and is stored trimmed. A payment without one is stored as `"Payment"`.
    - There is at least one share, and every `paidCents` and `owedCents` is a whole JSON number ≥ 0
      (`"1000"` as text is refused).
    - `recordedVia` is NULL or `settle_up`, and only on a payment.
    - Any malformed value (`2026-02-30`, …) is `HS422`.
  - An update keeps the stored `recorded_via` and ignores the mutation's `recordedVia`, so a member may
    edit a settle-up payment.
  - An update or delete whose `entryId` is stored in another group: `HS422`.
  - A delete keeps the shares (so it can be restored) and sets `updated_by_member_id` to the deleter.
  - An `entryId` already in use on `entry.create`: `23505` passes through.
  - Pulled `shares` are sorted by `member_id`.
  - The case table has 15 cases: the spec's 10, plus a payment, one cent split three ways (0/0 shares), two
    cents coming off, the cent coming off the share rounded up most, and two payers tied. Its test file
    also checks that each case adds up. `tsconfig.json` includes `scripts`.

**`006_conflicts.sql`**

- `entry_conflicts`, `ledger_entry_versions (entry_id, row_version, snapshot, PRIMARY KEY (entry_id,
row_version))`, no client grants on versions; every entry write inserts a version and deletes all but the
  newest 20.
- The conflict branch (§4.2) in `apply_entry_update` and `apply_entry_delete`; `base` copied from versions
  (NULL if pruned). `apply_conflict_resolve` (owner, member; `HS409` if resolved; applies the final entry
  or delete without a stale check; stamps the entry and the conflict).
- `pull_changes()`: `conflicts`.
- Tests: `supabase/tests/conflicts.test.sql` (spec's conflict cases).
- **As built:**
  - Each mutation takes one version. A conflict row takes it; a resolution's entry and conflict share it.
  - `baseVersion` must be a whole number (`HS422`). A stale change is validated first: an invalid one is
    rejected, not stored as a conflict.
  - Deleting an entry that is already deleted is accepted and does nothing, stale or not: no conflict.
  - `proposed` is normalised like a stored entry: the trimmed description (or `"Payment"`), `items` NULL
    for a payment, shares sorted by `memberId`, `"deletedAt": null`. Snapshot shares are sorted by
    `memberId` too, and `entryDate` is `"YYYY-MM-DD"`.
  - `conflict.resolve`:
    - `entry.kind` may be left out (the stored kind is used; another kind is `HS422`), and
      `entry.recordedVia` is ignored.
    - An unknown conflict, or one in another group, is `HS404`.
    - `HS409`'s reason is `"<name> already resolved this"`, with the resolver's display name.
    - `{"deleted": true}` on an entry already deleted keeps its first `deleted_at`.
  - Entries written before 006 get their current version recorded.

**`007_invites.sql`** (also `supabase/config.toml`: `enable_anonymous_sign_ins = true`,
`enable_manual_linking = true`)

- `group_invites`; column `SELECT` grant without `token_hash`. `apply_invite_create` (owner; the server
  stores `encode(sha256(convert_to(token, 'UTF8')), 'hex')` and never the token), `apply_invite_revoke`.
- `public.preview_invite(p_token TEXT) RETURNS JSONB` → `{ "groupId", "groupName", "invitedBy",
"claimMemberId", "unclaimed": [{ "memberId", "displayName" }], "alreadyMember" }`; `HS404` for unknown,
  expired or revoked. **Granted to `anon` and `authenticated`**, so the join screen works before signing in.
- `public.join_group(p_token TEXT, p_claim_member_id UUID DEFAULT NULL, p_display_name TEXT DEFAULT NULL)
RETURNS UUID` as in the spec; `p_display_name` names a new member when nobody is claimed (falls back to
  the profile name). Role `guest` if anonymous, else `member`; sets `joined_at`; stamps versions.
- `public.upgrade_guest() RETURNS VOID`: rejects anonymous callers; `guest` → `member` in every group;
  copies `auth.users.email` into `profiles.email`; stamps versions.
- Guest permission checks in every `apply_*` written so far.
- `pull_changes()`: `invites` (no `token_hash`).
- Tests: `supabase/tests/invites.test.sql`, `supabase/tests/guests.test.sql` (use
  `request.jwt.claims` with `"is_anonymous": true`).
- **As built:**
  - The guest rules are written into each `apply_*` from 004 on (role lists per change), so 007 adds none.
  - `invite.create`:
    - The token must match `^[A-Za-z0-9_-]{43}$` (`HS422`).
    - `claimMemberId` must be a non-member of this group who hasn't joined or been removed (`HS422`).
    - `expires_at` is the earlier of `expiresAt` and now + 14 days; without `expiresAt`, now + 14 days.
  - `invite.revoke` of a link never stored, or revoked already: accepted, does nothing. Of another group's
    link: `HS422`.
  - `preview_invite`:
    - `claimMemberId` is the link's non-member only while they can still be claimed, else `null`.
    - `unclaimed` is sorted by name (case-insensitive), then id.
    - `invitedBy` is the creator's name in the group, else their profile name.
    - `alreadyMember` is `false` signed out.
    - `HS404` also covers a deleted group, and from 008 a completed one.
  - `join_group`:
    - Signed out: `28000`.
    - A picked non-member who isn't in the group, or was removed: `HS422 That person is not in this group`.
      One who has joined: `HS422 Someone has already joined as that person`.
    - Nobody picked, and the link's non-member has joined or left since: the caller is added as someone new.
    - A returning leaver gets their old row back with the role they have now; a pick is ignored.
  - `upgrade_guest` is `HS403` while the JWT says anonymous, or `auth.users` is still anonymous or has no
    email. It upgrades every `guest` row of the caller (removed ones too), one version per group.
  - `supabase/config.toml` takes effect on `supabase stop` then `supabase start`; `db reset` keeps the old
    Auth settings.

**`008_complete.sql`**

- `groups.completed_at`, `groups.completed_by_member_id`; `require_member` refuses completed groups.
- `apply_group_complete` (owner): sets both columns; in the same transaction every `guest` row with a
  still-anonymous user becomes a non-member (`user_id` NULL, role `member`, `joined_at` NULL, stamped), and
  each such user with no other active membership is deleted from `auth.users`. `apply_group_reopen` (owner).
- `pull_changes()`: groups gain `completed_at`, `completed_by_member_id`.
- Tests: `supabase/tests/complete.test.sql` (spec's Completing case, with
  a member getting `HS403`). If `postgres` turns out unable to `DELETE FROM auth.users` on this Supabase
  version, stop and report it: the fallback (a queue drained by `pg_cron`) changes the design.
- **As built:**
  - `DELETE FROM auth.users` works from inside `push_changes()`: `postgres` has `DELETE` on `auth.users`
    (checked on the local stack, Postgres 17.11, CLI 2.122). No fallback is needed.
  - Unlinking covers every `guest` row whose user is still anonymous, including guests who had already
    left. A login is deleted when its user has no active row left in a group that isn't deleted.
  - While a group is completed, its invite links act as expired: `preview_invite` and `join_group` give
    `HS404` until it is reopened.
  - In a completed group everything but `group.reopen` and `group.delete` is `HS403`, leaving and
    completing again included. `group.reopen` of an open group: accepted, does nothing.

**`009_api.sql`**

- `api_tokens` as in the spec plus `rate_window_start TIMESTAMPTZ`, `rate_window_count INT NOT NULL DEFAULT
0`; no client grants.
- `public.create_api_token(p_name TEXT) RETURNS JSONB` → `{ "id", "token", "name", "createdAt" }`: not for
  anonymous callers (`HS403`); at most 10 live tokens per user (`HS422`); token = `'hsk_'` + base64url of
  `extensions.gen_random_bytes(32)` without padding (43 characters). `public.list_api_tokens() RETURNS
JSONB` → `[{ "id", "name", "scope", "createdAt", "lastUsedAt" }]` (live only, newest first).
  `public.revoke_api_token(p_id UUID) RETURNS VOID` (own only, idempotent).
- `CREATE SCHEMA IF NOT EXISTS api`; role `handshake_api` created `NOLOGIN` if missing (the password is
  never in a migration); `GRANT USAGE ON SCHEMA api`, `EXECUTE` on the four functions below, nothing else.
- `private.api_authenticate(p_token_hash TEXT) RETURNS UUID` per ADR-003 (`HS401`, `HS429`).
- Data functions, all `SECURITY DEFINER`, `VOLATILE`, authenticate first, then build the result in **one**
  statement. Shapes are camelCase and exactly what `src/server/api-v1/store.ts` expects:
  - `api.v1_me(p_token_hash TEXT) RETURNS JSONB` → `{ "userId", "displayName" }`.
  - `api.v1_groups(p_token_hash TEXT) RETURNS JSONB` → `[{ "id", "name", "role", "memberId", "paidCents",
"owedCents", "completedAt", "updatedAt" }]` for every group where the user has an active member row
    and the group is not deleted. Sums over not-deleted entries. `updatedAt` = the latest `updated_at` of
    the group, its members and its entries.
  - `api.v1_group(p_token_hash TEXT, p_group_id UUID) RETURNS JSONB` → one group as above plus `"members":
[{ "memberId", "displayName", "active", "paidCents", "owedCents" }]` (every member row, including left
    ones and non-members). SQL NULL if not accessible (see "As built" below).
  - `api.v1_entries(p_token_hash TEXT, p_group_id UUID, p_cursor JSONB, p_limit INT) RETURNS JSONB` →
    `{ "entries": [{ "id", "groupId", "kind", "description", "entryDate", "totalCents", "involved",
"paidCents", "owedCents", "hasConflict", "createdAt", "updatedAt", "deletedAt" }], "cursor": {
"<groupId>": <version> }, "hasMore", "removedGroupIds" }`. `p_group_id` NULL means every accessible
    group; given and not accessible → SQL NULL. `p_cursor` is the `groups` map from ADR-004 (`{}` = from the
    start). Order groups by id, entries by feed version then id; stop after `p_limit` entries but finish
    the current version. A fully read group's cursor value is its `head_version`. `removedGroupIds` = ids in
    `p_cursor` that are no longer accessible (they are left out of the returned map).
- `supabase/seed.sql` (new, local only): `ALTER ROLE handshake_api WITH LOGIN PASSWORD
'handshake_api_local';`.
- Tests: `supabase/tests/api.test.sql`: tokens stored only hashed; 43-character tokens; anonymous can't
  create; revoked → `HS401`; the 61st call in a minute → `HS429`; each `api.v1_*` returns only the owner's
  groups and shares, with hand-worked numbers for the $10 dinner; the feed cursor (first page, next page,
  a new group appears, a left group is reported in `removedGroupIds`, a conflict re-sends its entry);
  `SET ROLE handshake_api` can't `SELECT` any table, can't run `push_changes`/`pull_changes`, and has
  `EXECUTE` on no function outside `api` (checked over `pg_proc`).
- **As built** (wire contract changes for `postgres-store.ts`):
  - **`api.v1_group`, and `api.v1_entries` given a `p_group_id`, return SQL NULL** for a group that is
    unknown, deleted or not the owner's, instead of raising `HS404`. Raising would roll back the rate-window
    increment, and §9.11 says those calls count. The Postgres adapter maps a NULL result to
    `ApiStoreError("HS404")`; the memory adapter counts those calls too.
  - `HS429` carries `DETAIL` = the whole seconds until the window resets (`"1"`–`"60"`), for `Retry-After`.
    The handler may use it or keep working it out from `now`.
  - `create_api_token`, `list_api_tokens` and `revoke_api_token` are all `HS403` for anonymous callers and
    `28000` signed out. The name is trimmed and must be 1–60 characters (`HS422`).
  - `api.v1_entries`:
    - `p_limit` NULL means 100; below 1 means 1.
    - The returned `cursor` holds every group in scope. A group with changes of which none were read keeps
      its old value (0 if new).
    - `removedGroupIds` is sorted.
  - Groups in `v1_groups` and members in `v1_group` are sorted by name (case-insensitive), then id.
    `active` is `deleted_at IS NULL`, so a non-member is active.
  - Timestamps are Postgres's JSON form (`2026-11-03T18:20:00.123456+00:00`); the handler converts them
    with `toISOString()`. Cents are JSON numbers.
  - `postgres` holds `ADMIN` on `handshake_api` but not `SET`, so `api.test.sql` grants itself `SET` inside
    its rolled-back transaction.
  - `public.update_updated_at_column()` loses `EXECUTE` for `PUBLIC`, `anon` and `authenticated` (triggers
    don't need it). Outside the system catalogs, `handshake_api` can then execute exactly the four
    `api.v1_*` functions and select nothing.

**`010_categories_notes.sql`** (2026-11-08; also `supabase/templates/email-change-code.html` and
`[auth.email.template.email_change]` in `supabase/config.toml`, so "Keep my data" emails carry the code)

- `ledger_entries.category TEXT NULL`, one of `food`, `drinks`, `stay`, `travel`, `groceries`, `fun`; a
  table check keeps it NULL on payments. `groups.note TEXT NULL`, trimmed, 1–120 characters (blank → NULL).
- `entry.create`, `entry.update` and `conflict.resolve`'s final entry take an optional `category` (missing
  or null → none; anything else outside the list → `HS422`), checked in `private.entry_category` after the
  bill checks. `payment.record` with a non-null `category` → `HS422`.
- Entry snapshots (`ledger_entry_versions`, conflict `base` and `proposed`) gain `category`; a snapshot
  written before 010 has no key, which the device reads as null.
- `group.create` takes an optional `note`. New `group.describe { groupId, note }` sets or clears it,
  checked as the matrix action `group.rename` (owner, not in a completed group), one version per change.
  A note that isn't text or is over 120 characters (after trimming) → `HS422`.
- `pull_changes()` (redefined whole): groups gain `note`, entries gain `category`.
- Tests: `supabase/tests/categories_notes.test.sql`; `complete.test.sql` and `ledger.test.sql` pin the new
  key sets.

**`011_nudges.sql`** (2026-11-10; chat-spec decision 4, shipped before chat, in-app only)

- `public.nudges (id, group_id, from_member_id, to_member_id, amount_cents > 0, created_at, row_version)`;
  both members must be in the group (composite keys on `group_members (group_id, id)`) and differ. Indexes
  `(group_id, row_version)` and `(from_member_id, to_member_id, created_at)`. Members `SELECT` through
  `is_group_member()`; devices can't write it.
- Matrix: `nudge.send` for owner, member and guest; not in a completed group (`HS403`).
- `nudge.send { groupId, nudgeId, toMemberId, amountCents }`, checked in this order: `private.require`; a
  `nudgeId` already stored → accepted, nothing changes; then `HS422` "That person is not in this group",
  "You can't nudge yourself", "<name> left the group", "<name> hasn't joined", "<name> doesn't owe you
  anything" (`private.debt_between(group, from, to)`: summarizeGroup's pairwise debt over live bills and
  confirmed payments), the amount not whole cents from 1; then `HS409` "You nudged <name> today" when the
  same sender nudged the same person in the last 24 hours. The stored amount is the one the device sent
  (its debt at that moment); it doesn't follow later changes.
- `pull_changes()` (redefined whole): each group change gains `nudges`.
- Tests: `supabase/tests/nudges.test.sql` (also pins the group change's key set).

**`012_group_codes.sql`** (2026-11-10; owner decisions of 2026-11-10: one join code per group replaces invite
links, and guests get a personal code)

- Codes: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O, 1/I/L), made by
  `private.random_code()` from `extensions.gen_random_bytes` (bytes 248–255 skipped, so every character is
  equally likely). Stored without the dash; `private.normalise_code()` upper-cases and drops dashes and
  spaces, so typed codes are case-insensitive. Shown as `HX7-K2P`, linked as `/join/HX7K2P`.
- `groups.join_code TEXT NOT NULL UNIQUE` (check `^[A-HJKMNP-Z2-9]{6}$`), default `private.new_join_code()`
  (retries until unused), so `group.create` gets one without changing `apply_group_create`. Existing groups
  were backfilled, each in a new version. Members read it through the existing `SELECT` on `groups`; a group
  made offline has no code on the device until it syncs.
- Matrix: `group.recode` for the owner only, not in a completed group. `group.recode { groupId }` sets a new
  code in a new version; the old code stops working at once (`HS404`).
- `public.guest_codes (member_id PK, group_id, code, created_at, deleted_at, row_version)`; `(group_id, code)`
  unique among live codes; `(group_id, member_id)` references `group_members`. RLS: `SELECT` for the group's
  active owner (every guest code) and for the guest whose row it is (their own); other members see none.
  `private.give_guest_code()` makes one when a guest joins (no reset, no lock, no rate limit).
  `deleted_at` (soft, so the owner's device learns it) is set by the trigger `group_members_drop_guest_code`
  whenever a member row stops being a guest with a login (`role` leaves `guest` or `user_id` becomes NULL), in
  that row's version: `upgrade_guest()`, `group.complete` (guests become name-only people),
  `delete_account()`, and coming back as a login with an email. `private.hand_over()` re-stamps the group's
  guest codes so a new owner, already past their versions, pulls them.
- Unique names: `private.require_unique_name()` compares `lower(btrim(display_name))` with the group's active
  people (someone who left doesn't hold their name). `member.add`, `member.rename` (skipped when the name
  stays the same apart from case and spaces, so old duplicates stay) and `join_with_code` (someone new)
  raise `HS409` "`<name>` is already in this group". `group.create`'s owner name is the first.
- `public.preview_group(p_code TEXT)` (`anon`, `authenticated`) → `{ "groupId", "groupName", "ownerName",
"unclaimed": [{ "memberId", "displayName" }], "returning": [{ "memberId", "displayName" }],
"alreadyMember" }`. `unclaimed`: name-only people (no login, not left); `returning`: guests with a login
  and a live personal code; both sorted by name. `HS404` "This code doesn't work" for an unknown code or a
  deleted or completed group (it works again after reopen).
- `public.join_with_code(p_code TEXT, p_claim_member_id UUID DEFAULT NULL, p_display_name TEXT DEFAULT NULL,
p_personal_code TEXT DEFAULT NULL)` (`authenticated`) → the group id. Locks the group and finds the code
  again. Already an active member → nothing changes. With `p_personal_code`: `p_claim_member_id` must be an
  active person in the group (`HS422` "That person is not in this group"), not a member with an email
  (`HS422` "Sign in with your email to get back in"), with that live code (`HS422` "That code doesn't
  match"); the row's `user_id` moves to the caller (role `guest` if anonymous, else `member`), a
  `guest_handoffs` row records the login it left, and the caller's own old left row (if any) lets go of their
  login. Otherwise, in this order: the caller's old left row comes back; the name-only person
  `p_claim_member_id` (`HS422` "That person is not in this group" / "Someone has already joined as that
  person"); or someone new named `p_display_name` (else the profile name), unique. Anonymous callers join as
  guests and get a personal code in the same version.
- `public.guest_handoffs (id, group_id, member_id, from_user_id, moved_at)`; RLS `SELECT` for
  `from_user_id = auth.uid()`.
- `pull_changes()` (redefined whole): groups gain `join_code`; each group change gains `guest_codes` (the
  rows RLS lets the caller see); the reply gains top-level `moved_away` (ids of groups this login lost to a
  personal code, so the device can say "`<name>` is now signed in on another device" instead of treating it
  as a removal).
- `group_invites`, `invite.create`/`invite.revoke`, `preview_invite`, `join_group` stay (additive); the
  client stops using them once the screens move to codes. `join_group` does not check names or make
  personal codes.
- Tests: `supabase/tests/group_codes.test.sql`; `categories_notes`, `complete`, `nudges` and `sync` tests pin
  the new keys.

#### What chat 3 builds against (as built)

Functions (all `SET search_path = ''`):

| Function                                                                                                                                             | Returns                                                                                                                                                                                                                               | Called by               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `public.push_changes(p_mutations JSONB)`                                                                                                             | `{ "applied": [id], "rejected": [{ "id", "code", "reason" }] }`                                                                                                                                                                       | `authenticated`         |
| `public.pull_changes(p_cursors JSONB DEFAULT '{}')`                                                                                                  | `{ "group_ids": [id], "moved_away": [id], "changes": [{ "group_id", "version", "groups", "members", "entries", "conflicts", "invites", "nudges", "guest_codes" }] }`                                                                  | `authenticated`         |
| `public.preview_invite(p_token TEXT)`                                                                                                                | `{ "groupId", "groupName", "invitedBy", "claimMemberId", "unclaimed": [{ "memberId", "displayName" }], "alreadyMember" }`                                                                                                             | `anon`, `authenticated` |
| `public.join_group(p_token TEXT, p_claim_member_id UUID DEFAULT NULL, p_display_name TEXT DEFAULT NULL)`                                             | the group id (`UUID`)                                                                                                                                                                                                                 | `authenticated`         |
| `public.preview_group(p_code TEXT)` (012)                                                                                                            | `{ "groupId", "groupName", "ownerName", "unclaimed": [{ "memberId", "displayName" }], "returning": [{ "memberId", "displayName" }], "alreadyMember" }`                                                                                | `anon`, `authenticated` |
| `public.join_with_code(p_code TEXT, p_claim_member_id UUID DEFAULT NULL, p_display_name TEXT DEFAULT NULL, p_personal_code TEXT DEFAULT NULL)` (012) | the group id (`UUID`)                                                                                                                                                                                                                 | `authenticated`         |
| `public.upgrade_guest()`                                                                                                                             | `VOID`                                                                                                                                                                                                                                | `authenticated`         |
| `public.create_api_token(p_name TEXT)`                                                                                                               | `{ "id", "token", "name", "createdAt" }`                                                                                                                                                                                              | `authenticated`         |
| `public.list_api_tokens()`                                                                                                                           | `[{ "id", "name", "scope", "createdAt", "lastUsedAt" }]`, newest first                                                                                                                                                                | `authenticated`         |
| `public.revoke_api_token(p_id UUID)`                                                                                                                 | `VOID`                                                                                                                                                                                                                                | `authenticated`         |
| `api.v1_me(p_token_hash TEXT)`                                                                                                                       | `{ "userId", "displayName" }`                                                                                                                                                                                                         | `handshake_api`         |
| `api.v1_groups(p_token_hash TEXT)`                                                                                                                   | `[{ "id", "name", "role", "memberId", "paidCents", "owedCents", "completedAt", "updatedAt" }]`                                                                                                                                        | `handshake_api`         |
| `api.v1_group(p_token_hash TEXT, p_group_id UUID)`                                                                                                   | one group as above plus `"members": [{ "memberId", "displayName", "active", "paidCents", "owedCents" }]`, or NULL                                                                                                                     | `handshake_api`         |
| `api.v1_entries(p_token_hash TEXT, p_group_id UUID, p_cursor JSONB, p_limit INT)`                                                                    | `{ "entries": [{ "id", "groupId", "kind", "description", "entryDate", "totalCents", "involved", "paidCents", "owedCents", "hasConflict", "createdAt", "updatedAt", "deletedAt" }], "cursor", "hasMore", "removedGroupIds" }`, or NULL | `handshake_api`         |

Pull rows, snake_case, with exactly these keys (pgTAP checks each set; as of 012):

| Row                | Keys                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `groups`           | `id`, `name`, `note`, `base_currency`, `join_code`, `created_by`, `created_at`, `deleted_at`, `completed_at`, `completed_by_member_id`, `row_version`                                                                                                                                                                                                  |
| `members`          | `id`, `group_id`, `user_id`, `display_name`, `role`, `joined_at`, `deleted_at`, `row_version`                                                                                                                                                                                                                                                          |
| `entries`          | `id`, `group_id`, `kind`, `description`, `amount_cents`, `items`, `entry_date`, `notes`, `category`, `payment_status`, `payer_confirmed_at`, `receiver_confirmed_at`, `confirmed_at`, `closed_at`, `close_note`, `created_by_member_id`, `updated_by_member_id`, `created_at`, `updated_at`, `deleted_at`, `row_version`, `shares` (no `recorded_via`) |
| `entries[].shares` | `member_id`, `paid_cents`, `owed_cents`, `owed_to` (payer member id → cents; sorted by `member_id`)                                                                                                                                                                                                                                                    |
| `conflicts`        | `id`, `group_id`, `entry_id`, `base_version`, `base`, `proposed`, `proposed_by_member_id`, `created_at`, `resolved_at`, `resolved_by_member_id`, `resolution`, `row_version`                                                                                                                                                                           |
| `invites`          | `id`, `group_id`, `claim_member_id`, `created_by`, `created_at`, `expires_at`, `revoked_at`, `row_version`                                                                                                                                                                                                                                             |
| `nudges`           | `id`, `group_id`, `from_member_id`, `to_member_id`, `amount_cents`, `created_at`, `row_version`                                                                                                                                                                                                                                                        |
| `guest_codes`      | `member_id`, `group_id`, `code`, `created_at`, `deleted_at`, `row_version` (only the rows the caller may see)                                                                                                                                                                                                                                          |

The order of `changes` and of the rows in each list is not defined; the device must not rely on it.

Mutations: every one has `id` and `type` (the device's `at` is ignored). The server reads (who may: the
permission matrix, `private.may`):

| `type`                                           | Fields                                                                                                                                                               | Who                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `group.create`                                   | `groupId`, `memberId`, `name`, `displayName`; `note`, `baseCurrency` optional                                                                                        | Not anonymous                                                      |
| `group.rename`                                   | `groupId`, `name`                                                                                                                                                    | Owner                                                              |
| `group.describe`                                 | `groupId`, `note` (null or blank clears it)                                                                                                                          | Owner (checked as `group.rename`)                                  |
| `group.delete`, `group.complete`, `group.reopen` | `groupId`                                                                                                                                                            | Owner                                                              |
| `group.recode` (012)                             | `groupId`                                                                                                                                                            | Owner (not in a completed group)                                   |
| `member.add`                                     | `groupId`, `memberId`, `displayName`                                                                                                                                 | Owner, member                                                      |
| `member.rename`                                  | `groupId`, `memberId`, `displayName`                                                                                                                                 | Owner; anyone for themselves                                       |
| `member.remove`                                  | `groupId`, `memberId`                                                                                                                                                | Owner; anyone for themselves (leaving)                             |
| `entry.create`                                   | `groupId`, `entryId`, `description`, `amountCents`, `entryDate`, `notes`, `items`, `shares` (with `owedTo`); `category` optional; `kind` optional (only `"expense"`) | Everyone                                                           |
| `entry.update`                                   | as `entry.create`, plus `baseVersion`                                                                                                                                | Owner, member                                                      |
| `entry.delete`                                   | `groupId`, `entryId`, `baseVersion`                                                                                                                                  | Owner, member; guests their own                                    |
| `conflict.resolve`                               | `groupId`, `conflictId`, `entryId`, `resolution`, `entry` (the final bill fields with `category`, or `{ "deleted": true }`)                                          | Owner, member                                                      |
| `invite.create`                                  | `groupId`, `inviteId`, `token`, `claimMemberId`, `expiresAt`                                                                                                         | Owner, member                                                      |
| `invite.revoke`                                  | `groupId`, `inviteId`                                                                                                                                                | Owner, member for their own links; owner for others'               |
| `payment.record`                                 | `groupId`, `entryId`, `fromMemberId`, `toMemberId`, `amountCents`, `entryDate`, `notes`; `description` optional; no `category`                                       | Everyone when one side; owner, member between two who can't answer |
| `payment.confirm`, `payment.decline`             | `groupId`, `entryId`; decline also `note`                                                                                                                            | The side that hasn't agreed (also in a completed group)            |
| `payment.undo`                                   | `groupId`, `entryId`                                                                                                                                                 | Whoever recorded it, while pending                                 |
| `nudge.send`                                     | `groupId`, `nudgeId`, `toMemberId`, `amountCents`                                                                                                                    | Everyone, to someone with a login who owes them; once a day each   |

Rejection codes the device can see: `HS403`, `HS404` (only `conflict.resolve` among mutations), `HS409`,
`HS422`, and passed-through SQLSTATEs such as `23505` (an id already used), `23514` (a blank or overlong
name) and `22P02` (a `groupId`, `memberId` or similar that isn't a UUID). Signed out, PostgREST refuses
every online call made only to `authenticated` with `42501` (anon lacks `EXECUTE`) before the function runs,
so the `28000` the functions raise is not what the device sees.

### 11.3 Done for chat 2

`bun run db:reset` and `bun run test:db` pass with every file above; `bun test`, `bun run typecheck` and
`bun run build` still pass (no changes to `src/`). Report any place the SQL or a wire contract had to differ
from this section, so chat 3 builds against what exists, and update §11.2.

### 11.4 Change list of 2026-11-04 (chat 2: edit 004–009 in place)

These supersede §11.2 where they differ. The migrations had run only on local stacks, so they are
edited in place rather than followed by a new migration; `bun run db:reset` rebuilds them. Work on a
branch with a PR (the owner's rule).

1. **Permission matrix (ADR-007).**
   - Add `private.may(p_action TEXT, p_role TEXT) RETURNS BOOLEAN` and
     `private.allowed_when_completed(p_action TEXT) RETURNS BOOLEAN` (both `IMMUTABLE`, one `CASE` each)
     implementing spec decision 8's table, in 004.
   - Replace `private.require_member(user, group, roles[], allow_completed)` with
     `private.require(p_user, p_group_id, p_action) RETURNS public.group_members`: lock the group row,
     active member, not deleted, `allowed_when_completed` if completed, then `may`. Every `apply_*` works
     out its action (own/others, self/others) and calls it once; the inline role checks go.
   - Changes of rule: `member.add` and `invite.create` for members too; `invite.revoke` split into own
     (`created_by` is the caller) and others; leaving (`member.remove.self`) works in a completed group.
   - Create `tests/fixtures/permission-cases.ts` (hand-transcribed from decision 8), a
     `scripts/permission-cases-sql.ts` generator, the generated `supabase/tests/permission_cases.test.sql`,
     and extend the drift test to it; `package.json` script `gen:permission-cases`. In the per-area pgTAP
     files, keep one allowed and one refused call per action through `push_changes` (wiring), and drop
     the rest of the role checks there.
2. **Per-payer rounding and share parts (ADR-008).**
   - `private.compute_shares()` rounds per payer (architecture §9.3) and returns parts:
     `(member_id, payer_member_id, owed_cents)` plus each member's `paid_cents`.
   - Add `ledger_share_parts (entry_id, group_id, member_id, payer_member_id, owed_cents)`, PK
     `(entry_id, member_id, payer_member_id)`, RLS like shares, written with every entry. Validation
     compares shares **and** parts. Mutations' shares carry `owedTo` (camelCase map payer → cents).
   - Update `tests/fixtures/ledger-cases.ts`: add `parts` to each case, change "Several payers, with a
     cent" (owed P1 734, P2 733, P3 733, P4 400, P5 400; parts in the spec's Testing Checklist), and
     replace `payments` with pairwise `debts`; regenerate the pgTAP file.
3. **Handshake payments (ADR-008, spec decision 17).**
   - Drop `recorded_via`. Add `payment_status`, `payer_confirmed_at`, `receiver_confirmed_at`,
     `confirmed_at`, `closed_at`, `close_note` (≤ 200) to `ledger_entries`, with a check that bills have
     a NULL status and payments a non-NULL one.
   - New `apply_payment_record`, `apply_payment_confirm`, `apply_payment_decline`, `apply_payment_undo`.
     Record: two different members of the group; the caller is one side (`payment.record.own`), or
     neither side has a login and the caller is a full member (`payment.record.others`); the shares are
     built from from/to/amount; status `confirmed` at once (with `confirmed_at`) when the other side, or
     both sides, have no login, else `pending` with the caller's side time set; refuse with `HS409` when
     the pair already has a pending payment. Confirm and decline: the caller is the side that hasn't
     agreed, else `HS403`; not pending → `HS409`; confirm sets the other time and `confirmed_at`. Undo:
     the starter (`created_by_member_id`), pending only. Allowed in a completed group: confirm and decline.
   - `entry.create`, `entry.update` and `entry.delete` refuse payments (`HS422`); payments never enter the
     conflict branch.
   - Every payment write stamps the next group version; `confirmed_at`'s version is the payment's feed
     version for the API.
   - Tests: new `supabase/tests/payments.test.sql` (the spec's handshake cases).
4. **Completing.** `group.complete` no longer cares about settle-up payments; pending payments stay pending.
5. **Account deletion (spec decision 19).** `public.delete_account() RETURNS VOID` for `authenticated`
   (guests included), in 008: name-only rows, ownership hand-over or group deletion, pending payments to
   `undone` (with `closed_at`), API tokens deleted, `auth.users` row deleted, versions stamped. Tests:
   `supabase/tests/delete-account.test.sql`.
6. **API (ADR-004).** Replace `api.v1_entries` with `api.v1_payments(p_token_hash, p_group_id, p_cursor,
p_limit) → { "payments": [{ "id", "groupId", "groupName", "direction", "counterpartyMemberId",
"counterpartyName", "amountCents", "entryDate", "notes", "confirmedAt" }], "cursor", "hasMore",
"removedGroupIds" }` over confirmed payments involving the owner. `api.v1_groups` drops `paidCents` and
   `owedCents` in favour of per-member totals the handler sums; `api.v1_group` returns `members` with
   `paidCents`, `owedCents` and `owedTo` (per-pair totals over live bills and confirmed payments), from
   which the handler gets debts with `summarizeGroup`. Keep the NULL-for-not-found rule.
7. **Pull.** Entries carry `shares[].owed_to` and the payment fields; no `recorded_via`.

#### As built (chat 2, 2026-11-04/05, branch `chat2/handshake-payments-permissions`)

Where the SQL differs from the list above. Chat 3 builds against these.

- `private.compute_shares` returns one row per share: `(member_id, paid_cents, owed_cents, owed_to JSONB)`,
  with `owed_to` = the non-zero parts (payer id → cents), in bill order. That is the same shape as
  TypeScript's `Share.owedTo`. `ledger_share_parts` is written from it, with positive parts only.
- `groups.completed_at` and `completed_by_member_id` are added in 004, where `private.require` checks them.
  `pull_changes` is defined once, in 007. Bill `entry.update` and `entry.delete` live only in 006.
- `groups.created_by` and `group_invites.created_by` are nullable `ON DELETE SET NULL`, so
  `delete_account()` works for people who made groups or links. Pulled `created_by` and `preview_invite`'s
  `invitedBy` can therefore be null, and a link whose maker is gone can only be revoked by the owner.
- `api.v1_groups` keeps the owner's own `paidCents` and `owedCents`, over live bills and confirmed
  payments only; the handler's `balanceCents` = paid − owed (**confirmed**). `api.v1_group` members are
  `{ memberId, displayName, active, paidCents, owedCents, owedTo }`. `api.v1_payments` rows are as in
  `docs/api-v1.md`; the feed version is the `row_version` of the write that confirmed the payment.
- "Can answer a handshake" means **an active member row with a `user_id`** (corrected 2026-11-05; the first
  build used "has a `user_id`, even if they left"). A payment with someone who has left, has no login or
  deleted their account is confirmed when recorded. `member.remove` (leaving or being removed) undoes that
  person's pending payments in the group, with `closed_at` set, as `delete_account()` does. Built as
  `private.can_answer(member)`, which `payment.record` uses for both "confirmed at once" and `.others`, and
  `private.undo_pending_payments(member, version)`, called by `member.remove` and `delete_account()`.
- `payment.record` takes an optional `description` (default "Payment", ≤ 120). The one-pending-per-pair
  `HS409` applies in either direction. A payment recorded for two people who can't answer sets only
  `confirmed_at`.
- Order of checks when answering or undoing: an unknown id is accepted and does nothing; then a payment of
  another group or a bill gives `HS422`; then not pending gives `HS409`; then the wrong side or not the
  starter gives `HS403`.
- Decline `note` is trimmed, ≤ 200 characters, and blank is stored as NULL. Bill `entry.create` may omit
  `kind`, and `kind: "payment"` gives `HS422`. Each share's `owedTo` must match `compute_shares` exactly.
- `delete_account()` also undoes pending payments in groups the person had left. API tokens go with the
  `auth.users` cascade. It shares `private.hand_over()` with leaving.
- The permission drift test is its own file, `tests/lib/permission-cases-sql.test.ts`. The ledger case table
  replaces "payers tie" with "Two payers, one item each" (Alex 666, Jo 667, Sam 667; debts Alex→Jo 333,
  Alex→Sam 333).

## 12. Handoff to chat 3 (domain logic, sync, API, tests)

Read first: `AGENTS.md`, the spec, §§4 and 7–10 here (§9 is the module map you build to), `docs/api-v1.md`, `docs/api-v1.openapi.yaml`, and chat
2's report. Don't build screens; keep the existing ones compiling with the smallest edits.

### 12.1 Logic and sync (client)

Chat 3 builds and tests modules M1–M4, M7 and M8. Each one is tested only through the interface in §9.

1. **M7** `src/lib/money.ts`:
   - `parseAmount(input)` and `formatAmount(cents)` (`"$1,234.50"`, `"−$3.33"`, en-US, with the U+2212
     minus sign).
   - Remove `minorUnitDigits` and `splitEvenly` and their tests.
   - Bring `tests/lib/money.test.ts` in line with the spec's cases.
2. **M1** `src/lib/ledger.ts`: build `computeShares`, `validateEntry` and `summarizeGroup` exactly as in
   §9.3, test-first.
   - `tests/lib/ledger.test.ts` loops over `tests/fixtures/ledger-cases.ts` (made by chat 2).
   - It also runs the seeded invariants (§10.1) and one failing draft per `HS422` rule.
3. `src/lib/sync/types.ts`:
   - `MemberRow`: `role` becomes `"owner" | "member" | "guest"`; it gains `joinedAt`.
   - `GroupRow`: drops `baseCurrency`; gains `completedAt` and `completedByMemberId`.
   - New rows: `EntryRow` (with `items` and `shares`), `ConflictRow`, `InviteRow`, `InviteTokenRow`.
   - `Mutation`: the full union from the spec's "New mutations" (no `member.setRole`). `group.create`
     stops sending `baseCurrency`.
   - `RejectedMutation` gains `code`; `GroupChanges` gains `entries`, `conflicts` and `invites`.
   - `SyncStore` and `SyncTransport` stay as they are (§9.6).
4. **M8** `src/lib/sync/wire.ts`: map snake_case pull rows to camelCase for the new rows (shapes in §11.2),
   tested in `wire.test.ts`.
5. **M3** `src/lib/sync/local.ts`:
   - Reshape `LocalTables` to the `Rows<T>` form in §9.5. Move the "gone group drops its children" rule
     into `mergePull`.
   - `applyMutation` handles every type; for `invite.create` it also stores the token in `inviteTokens`.
   - `mergePull` replaces entries whole and doesn't replay stale updates or deletes made by someone else.
   - `tests/support/memory-tables.ts` becomes one generic `Rows<T>` over a `Map`; `dexieTables(db)` becomes
     one line per table.
   - Tests: `tests/lib/sync/local.test.ts` and `merge.test.ts`.
6. Dexie:
   - `src/lib/local-db.ts`: Dexie version 2 with the stores from the spec.
   - `createDexieSyncStore`'s transaction covers the new tables.
7. **M2** `src/lib/changes.ts`: `planChange`, `createCommitter` (`commit`) and `useCommit` exactly as in
   §9.4.
   - Delete `src/lib/sync/mutate.ts`; `commit` is the only local writer.
   - Move `createGroup` and `renameGroup` out of `groups.ts` into intents, and update their two callers.
   - `groups.ts`, `members.ts`, `entries.ts` and `invites.ts` hold read hooks only.
   - `signed-in-layout.tsx` builds the committer (rebuilt when the user id or `isAnonymous` changes),
     provides it through context, and shows "Couldn't save on this device" when `commit` throws.
   - Add `fake-indexeddb` as a dev dependency.
   - Tests: `tests/lib/changes.test.ts` (role matrix, each intent, each refusal, idempotent answers) and
     `tests/lib/changes.commit.test.ts` (the five cases in §9.4).
   - Update `AGENTS.md` in the same change: rule 2 of "How data works" and "Adding a new kind of change"
     name `commit(intent)` and `planChange()` instead of `mutate()`, and the Layout block loses `mutate`.
8. **M8** `supabase-transport.ts` gains the six online functions (§9.8), each throwing `TransportError`.
   `src/lib/auth.tsx` gains guest sign-in and "keep my data".
9. Leave the UI almost untouched:
   - `signed-in-layout.tsx`: toast text per `code` (the spec's rejection toasts).
   - `pages/group.tsx` and `pages/groups.tsx`: drop the currency label, and call `useCommit()` for create
     and rename (navigating with `createdId` after create).
   - Nothing else.
10. `tests/lib/sync/engine.test.ts`: still passes, untouched, which proves the seams held.

### 12.2 API (M9)

1. Dependencies: none at runtime (`Bun.sql`, ADR-006); `ajv` (and `yaml` if Bun's YAML import doesn't fit)
   as dev dependencies. Add `postgres` only if `Bun.sql` fails the store contract suite through Supavisor.
2. `src/server/api-v1/store.ts`: the `ApiStore` seam exactly as in §9.11, with `ApiStoreError`.
3. `src/server/api-v1/index.ts`: `createApiV1({ store, now })`, with the order of checks and the invariants
   in §9.10.
   - Bearer token format: `^hsk_[A-Za-z0-9_-]{43}$`.
   - Hash: hex SHA-256 of the whole token, through `crypto.subtle`.
   - Cursor: base64url JSON per ADR-004.
   - Internal files: `http.ts`, `cursor.ts`, `token.ts`, `types.ts`.
4. Adapters at the `ApiStore` seam:
   - `src/server/api-v1/postgres-store.ts`: `createPostgresApiStore(sql)`, one `SELECT api.v1_*` per method.
   - `tests/support/memory-api-store.ts`: `createMemoryApiStore(fixture)`.
5. `api/v1/[...path].ts`, the composition root:
   - A module-level `new SQL({ url: process.env.HANDSHAKE_API_DATABASE_URL, prepare: false, max: 5,
idleTimeout: 20, connectionTimeout: 10 })` from `bun`. It runs on Vercel's Bun runtime (`bunVersion` is
     already in `vercel.json`).
   - `createApiV1`, with `GET`, `OPTIONS`, `POST`, `PUT`, `PATCH` and `DELETE` all delegating to it. If the
     Bun runtime doesn't route method exports from `api/v1/[...path].ts`, use its documented form instead
     (`Bun.serve({ fetch: handle })` in one `api/` file, with a rewrite from `/api/v1/*`).
   - Add `api` to `tsconfig.json` `include`. Runtime imports are relative (ADR-001).
6. `vercel.json`: the SPA rewrite becomes `{ "source": "/((?!api/).*)", "destination": "/index.html" }`.
   `vite.config.ts`: Workbox `navigateFallbackDenylist: [/^\/api\//]`.
7. Tests, all through interfaces:
   - `tests/api/v1.handler.test.ts` and `tests/api/v1.contract.test.ts`, through `handle(request)` with the
     memory store. The contract test loads the YAML, closes schemas per ADR-002, validates every response
     with `ajv/dist/2020`, and checks the golden JSON.
   - `tests/api/store.contract.ts`, run by `memory-store.test.ts` (always) and `postgres-store.test.ts`
     (opt-in).
   - `tests/server/import-paths.test.ts`.
8. `package.json` scripts `test:api-db` and `api:lint`. `.env.example` gains `HANDSHAKE_API_DATABASE_URL`
   with the local value.
   - `bunx @redocly/cli@1 lint` was run on the contract on 2026-11-03: valid, with one warning, the
     missing `info.license`. The API is private and has no license, so add `redocly.yaml` with
     `rules: { info-license: off }` to make `api:lint` exit clean.
9. Run `bunx vercel build` once (or `vercel dev`) to confirm the function bundles and routes on the Bun
   runtime. Record the result in the report.

### 12.3 Done for chat 3

`bun run typecheck`, `bun test`, `bun run build`, `bun run test:db` and `bun run api:lint` exit 0;
`bun run test:api-db` passes against the local stack; the app still creates and renames groups offline and
online. The report lists anything that differs from `docs/api-v1.md` (which must then be updated) and the
manual checks for the owner.

### 12.4 Change list of 2026-11-04 (chat 3)

These supersede §§12.1–12.2 where they differ. Build against chat 2's report on §11.4.

1. **M1:** the interface in §9.3: `Share.owedTo`, per-payer rounding, `summarizeGroup(entries, members)`
   returning `people` and pairwise `debts`, skipping deleted bills and payments that don't count.
2. **M10:** `src/lib/permissions.ts` and `tests/lib/permissions.test.ts` over the permission case table.
3. **M2:** the payment intents (`recordPayment`, `confirmPayment`, `declinePayment`, `undoPayment`) and
   their rules (§9.4); no tick or untick; `deleteAccount` is not an intent (it is online only).
4. **Sync types:** the payment mutations from spec "New mutations"; `EntryRow` gains the payment fields;
   shares gain `owedTo`; `entry.create` loses `kind` (bills only) and `recordedVia`.
5. **M8:** `deleteAccount()` in `supabase-transport.ts`; after it succeeds, `clearLocalData()` and sign out.
6. **M9:** `/payments` and `/groups/{id}/payments` replace the entries routes; `GET /groups/{id}` returns
   `debts`; `ApiStore.entries` becomes `payments`; the memory store, the store contract suite and the
   golden JSON follow `docs/api-v1.md` (2026-11-04).
7. Slice 8 (chat, nudges, signals, M11) is not part of this pass.

#### As built (chat 3, 2026-11-08; client half replaced 2026-11-09)

The API half of chat 3 ships as built in PR #3. The client half (M1–M3, M7, M8, M10) ships from the
screens branch (`feature/many-hands-ui`), which built the same interfaces in parallel and adds migration 010. Where that code differs from §§9 and 12:

- **`planChange` context.** `ctx` carries `isAnonymous` (only `createGroup` needs it); `GroupState.me` is
  `{ memberId, role, isAnonymous }`, and a caller with no active row gets `HS403` for every group intent.
- **Answering a payment that is no longer pending** plans nothing, on this device, whoever answered it;
  the screens hide the buttons then, and the server's `HS409` covers an answer that raced another device.
- **Refusals the server words differently.** Name lengths (`23514` on the server) and an unknown conflict
  (`HS404`) plan `HS422`, since `Plan`'s codes are `HS403`, `HS409` and `HS422`.
- **`ExpenseDraft`** is `{ description, entryDate, notes, category, items }`; `planChange` works out the
  amount and shares from the items. `createdId` also names a person added with `addPerson`.
- **Read hooks:** `groups.ts` (`useGroups`, `useGroup`, `useWaitingChanges`, `useUnsyncedIds`),
  `members.ts` (`useMembers`, `useMyMember`), `entries.ts` (`useEntries`, `useEntry`, `useGroupSummary`,
  `usePendingPayments`, `useConflicts`, `useOpenConflicts`, `useGroupCategory`, `useGroupCategories`),
  `invites.ts` (`useInvites`, `useInviteToken`).
- **Dexie versions 2 and 3.** `inviteTokens` is indexed by `groupId` too. Version 3 adds `note` and
  `category`; each upgrade clears the cursors so the next pull sends every group whole.
- **A rejected change leaves no trace.** After any rejection the device clears its cursors and pulls again;
  a pull from cursor 0 replaces the group's rows with the server's, then replays what is still unsent.
- **`RejectedMutation.code`** is optional, so `engine.test.ts` stays untouched.
- **Online functions** throw `TransportError { code, message }` with the SQLSTATE, or `"network"`.
  `auth.tsx` has guest sign-in, "keep my data", `deleteMyAccount()`, and `endIfAccountGone()`, which signs a
  device out when its login was deleted (a guest's, by completing a group).
- **API.** `createApiV1({ store })`, with no clock (see §9.10). A group id that isn't a UUID is an unknown
  path (404) and never reaches the store. A person's `debts` are sorted by the other person's name. The
  YAML is read with Bun's built-in `Bun.YAML`, so `yaml` is not a dependency; `ajv` and `ajv-formats` are.
- **Store contract suite.** Each adapter is seeded through its own `ApiSeeder`: the Postgres one through
  `push_changes`, `join_group` and `create_api_token` as each signed-in user, over an admin connection
  (`HANDSHAKE_TEST_ADMIN_DATABASE_URL`, local `postgres` by default). Expected cursor values come from each
  group's head version, since the two adapters stamp different absolute versions.
- **Not checked:** `Bun.sql` through Supavisor's transaction mode (the local pooler is off; the suite ran
  on the direct connection), and `bunx vercel build` (needs the owner's Vercel login; see ADR-001).

## 13. Risks specific to this design

- **Vercel import resolution.** Mitigated by relative runtime imports and a guard test (ADR-001).
- **`auth.users` deletion from SQL** on completion: works on the local stack (chat 2, §11.2 008). Production
  runs the same Supabase roles, but check it once there with a throwaway guest before relying on it.
- **Supavisor and custom roles.** `handshake_api` must have `LOGIN` and a password in production, and the
  pooler user is `handshake_api.<project-ref>`. Checked by the owner's first `GET /api/v1/me` in production.
- **Turnstile inside the native apps' web view** needs the app's origin allowed in the Turnstile widget
  settings; check before enabling anonymous sign-ins in production.
- **Cursor size.** The feed cursor grows by about 50 characters per group; fine for dozens of groups. If a
  person reaches hundreds, move the cursor server-side (a cursor id), which is invisible to Pholio.
- **Single owner.** With no admins, an absent owner blocks completing and removing people (ADR-005).
- **Two copies of the permission rule.** Mitigated by the shared case table and its drift test (ADR-007).
- **Handshakes left waiting.** A pending payment never counts until the other side answers; Settle up and
  nudges (slice 8) keep it visible.
