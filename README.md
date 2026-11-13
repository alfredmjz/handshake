# Handshake

Track who owes who in your friend group. No real money moves; Handshake
only keeps the record. It works offline and syncs when you're back online.

## Quick start

Needs [Bun](https://bun.sh) and Docker Desktop.

Create `.env.local` (git-ignored) with these, taking the URL and publishable key from `bunx supabase status`:

```
VITE_SUPABASE_URL=http://127.0.0.1:55321
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>
# Server only (the API function and `bun run test:api-db`); never prefix it with VITE_.
HANDSHAKE_API_DATABASE_URL=postgresql://handshake_api:handshake_api_local@127.0.0.1:55322/postgres
# Local auth emails go out through Resend (supabase/config.toml reads it).
RESEND_API_KEY=re_…
```

Then:

```bash
bun install
bun run db:start
```

Start Supabase through `bun run` (`db:start`, `db:reset`), which loads `.env.local` for it. Then:

```bash
bun run dev
```

Open http://localhost:5173 and sign in with the 6-digit code emailed to you. Until a sending domain is
verified in Resend, codes only reach the Resend account's own address. To skip the code, use the test accounts
(only in `bun run dev` against the local Supabase): **Owner** (`owner@handshake.test`), **Payee**
(`payee@handshake.test`) and **Guest**, from the Welcome screen or under "Test accounts (local)" in the account menu,
which switches straight to another. The guest stays the same guest between switches.

## Checks

```bash
bun run typecheck
bun test
bun run test:db
bun run build
```

## Mobile

The native app bundles the built site, so it opens with no connection.

```bash
bun run mobile:add:android
bun run mobile:sync
bun run mobile:open:android
```

On an emulator or phone, `127.0.0.1` is the device itself: point `VITE_SUPABASE_URL` at your computer's
LAN address before `mobile:sync`.

See `AGENTS.md` for how sync works and the project rules.
