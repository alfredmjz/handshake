# Handshake — Agent Guidelines

Handshake tracks who owes who inside a friend group. No real money moves in or out: it only keeps the
record. It is a separate app from Pholio (the owner's
personal finance tracker) and stays standalone, with its own UI. Handshake never calls Pholio: Pholio
reads from Handshake through Handshake's versioned, read-only API (`/api/v1`), never through
Handshake's database (see `docs/shared-ledger-spec.md`).

## Stack

| Area     | Technology                                                                       |
| -------- | -------------------------------------------------------------------------------- |
| Runtime  | **Bun 1.3** for everything (`bun install`, `bun run …`, `bun --bun <tool>`)      |
| Node.js  | **26 LTS**, only where a host needs it (Vercel's build, API fallback)            |
| Client   | **Vite 7 + React 19 + React Router 7**, a static single-page app                 |
| Offline  | **Dexie** (IndexedDB) on the device, `vite-plugin-pwa` service worker on the web |
| Server   | **Supabase**: Postgres + RLS, Auth with 6-digit email codes                      |
| Mobile   | **Capacitor 8**, bundling `dist/` (not loading a hosted URL)                     |
| UI       | **shadcn/ui** on Tailwind 3.4 and Radix, sonner, lucide; Funnel Display + Sans   |
| Language | TypeScript 5.9, `strict`                                                         |
| Format   | Prettier: tabs, width 120, CRLF, double quotes, trailing commas es5              |

## Commands

| Command               | Purpose                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `bun run db:start`    | Start the local Supabase (Docker); migrations apply on start                                          |
| `bun run db:reset`    | Rebuild the local database from `supabase/migrations/`                                                |
| `bun run dev`         | Vite dev server on http://localhost:5173                                                              |
| `bun run typecheck`   | `tsc --noEmit` — must exit 0                                                                          |
| `bun test`            | Unit tests in `tests/`                                                                                |
| `bun run test:db`     | pgTAP tests in `supabase/tests/` against the local Supabase                                           |
| `bun run test:api-db` | The ApiStore contract suite against the local Supabase (`HANDSHAKE_API_DATABASE_URL` in `.env.local`) |
| `bun run api:lint`    | Lint `docs/api-v1.openapi.yaml` with Redocly                                                          |
| `bun run build`       | Production build into `dist/` — must exit 0                                                           |
| `bun run format`      | Prettier                                                                                              |
| `bun run mobile:*`    | Capacitor: `mobile:sync`, `mobile:add:ios`, `mobile:open:android`, …                                  |

Local ports are shifted so this stack runs next to Pholio's: API 55321, DB 55322, Studio 55323,
Mailpit (sign-in emails) 55324. Do not move them back to 543xx.

## Layout

```
src/
  app.tsx, main.tsx        routes and entry
  pages/                   one file per screen
  components/              containers (screen, book-cover, money, pickers, editor-dialog, confirm-dialog,
                           notices, sync-status) and art/ (hands, faces, doodles, shake scene)
  components/ui/           shadcn/ui primitives (button, card, dialog, tabs, toggle-group, list, field, …)
  lib/
    local-db.ts            Dexie schema; the app reads only from here
    sync/                  types, local apply/merge, engine, controller, transport
    changes.ts             planChange() and commit(intent): the only way screens change data
    ledger.ts              shares, entry checks, balances and debts (pure)
    permissions.ts         the role matrix (mirrors private.may)
    groups.ts              read hooks, with members.ts, entries.ts and invites.ts
    auth.tsx, money.ts, ids.ts, supabase.ts
  server/api-v1/           API v1 for Pholio: createApiV1({ store }) and the ApiStore adapters
api/v1/[...path].ts        the Vercel function (composition root); runtime imports are relative
supabase/
  migrations/              numbered SQL, applied in filename order
  tests/                   pgTAP
tests/                     bun unit tests, mirroring src/ paths; fakes in tests/support/
```

## How data works (offline-first)

1. **Screens read only from Dexie** (`useLiveQuery`). They never query Supabase.
2. **Every change is an intent carried out by mutations** (`src/lib/sync/types.ts`). Screens call
   `commit(intent)` (`useCommit()`, `src/lib/changes.ts`): in one transaction it reads the group,
   `planChange()` turns the intent into mutations (or the refusal the server would give), and each is
   applied to Dexie and queued in `outbox`. Never write to Dexie tables any other way.
3. **The server is written only through `push_changes()`**, which applies each mutation in its own
   savepoint, records its id in `sync_mutations` so a retry is not applied twice, and rejects what the
   caller may not do. Clients have `SELECT` only on tables; keep it that way.
4. **`pull_changes(cursors)`** returns rows whose `row_version` is past the device's cursor for each
   group. Every write takes the next version with `private.next_group_version()`, which locks the group
   row so versions commit in order. Any new table synced per group needs `row_version` and must be
   stamped the same way.
5. **Sync order is push, then pull**; after a pull, still-unsent mutations are replayed on top
   (`mergePull`). Server rows win once they arrive.
6. **No Realtime.** The controller syncs on start, after each change, on reconnect, when the app is
   reopened, and once a minute.
7. **IDs are made on the device** with `newId()`, so rows exist before the server sees them.
8. **Deletes are soft** (`deleted_at`), so other devices receive them as rows.

Adding a new kind of change: add it to the `Mutation` union, plan it from an intent in `planChange()`
(`src/lib/changes.ts`, with the server's checks in the server's order), handle it in `applyMutation()`
(`src/lib/sync/local.ts`) and in `private.apply_mutation()` (new migration), then add unit and pgTAP tests.
`supabase-transport.ts` is the only file that talks to Supabase about data; keep it that way so the
backend can change later.

## Database rules

- Migrations are additive and safe to re-run: `IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`.
  Version prefixes are unique.
- Internal functions live in the `private` schema with no grants. Public functions get explicit
  `REVOKE … FROM PUBLIC, anon` and `GRANT … TO authenticated`.
- Group data is visible to members only, through `public.is_group_member()` (SECURITY DEFINER so policies
  don't recurse).
- Add a pgTAP test for every change to the sync functions or permissions, with expected values worked out by hand.

## Money and dates

- Amounts are **integers in the currency's minor unit** (`src/lib/money.ts`); never store or add floats.
  Splits must add up to the total exactly (`splitEvenly`).
- Each group has a `base_currency`. Expenses in other currencies will store the original amount, its
  currency, and the rate used.
- Calendar dates are `YYYY-MM-DD` strings; timestamps are ISO strings.
- Balances are computed on the device from local rows (they must work offline), in pure TypeScript
  with unit tests. The server validates what it stores (e.g. splits summing to the amount).

## Conventions

- Imports: React → third-party → `@/…`; `import type` for types; `@/*` maps to `src/*`.
- Comments only where logic is not obvious. No doc blocks or change narration.
- Follow `docs/design.md`: few words, screens built from the primitives, spacing from the tokens
  (`gap-control`, `gap-stack`, `gap-section`, `p-panel`, `py-row`, `px-page`), money in Funnel Display, no cursive.
- Use the theme tokens in `src/styles/globals.css` (`type-*` roles, `bg-card`, `text-muted-foreground`,
  `border-border`, `text-owed`, `bg-category-*`, …); no hard-coded colours or font sizes. New spacing, size or
  radius tokens also go in `src/lib/utils.ts` so `cn()` merges them.
- Lists and pickers sort alphabetically by the label people read, case-insensitive.
- Layouts work at 375px and 1440px.

## Verification

A change is done when `bun run typecheck`, `bun test` and `bun run build` exit 0, plus `bun run test:db`
for SQL. For UI changes, check the screen in the browser at 375px and 1440px, including offline
(DevTools → Network → Offline) and coming back online.

After each change, give the owner step-by-step manual checks: one action per step and the exact result.

## Don't

- Don't commit, push or open PRs unless asked.
- Don't read from Supabase in components or write to Supabase tables directly.
- Don't enable Supabase Realtime.
- Don't put Pholio's database keys or URLs in this app.
- Don't create `ios/` or `android/` by hand; generate them with `bun run mobile:add:*`.
