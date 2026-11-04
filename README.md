# Handshake

Track who owes who in your friend group, and plan trips together. No real money moves; Handshake
only keeps the record. It works offline and syncs when you're back online.

## Quick start

Needs [Bun](https://bun.sh) and Docker Desktop.

```bash
bun install
bun run db:start
cp .env.example .env.local
```

Fill `.env.local` with the API URL and publishable key printed by `bunx supabase status`, then:

```bash
bun run dev
```

Open http://localhost:5173, enter any email, and read the 6-digit code at http://127.0.0.1:55324
(local emails never leave your machine).

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
