# Handshake

Track who owes who in your friend group. No real money moves; Handshake only keeps the record. It works
offline and syncs when you're back online.

One React build runs as a PWA on the web and inside Capacitor apps for iOS and Android. Supabase (Postgres,
Auth) is the server, and a read-only API at `/api/v1` lets Pholio read payments.

## Quick start

### 1. Install the tools

| Tool                                                              | Version                      | Why                                        |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| [Bun](https://bun.sh)                                             | 1.4.4 (`packageManager` pin) | Installs, scripts, tests, the API function |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Running                      | The local Supabase stack                   |
| Git                                                               | Any                          |                                            |

Node.js is not needed on your machine. The Supabase CLI comes in with `bun install` (devDependency `supabase`).

### 2. Install and start the database

```bash
git clone https://github.com/alfredmjz/handshake.git
```

```bash
cd handshake
```

```bash
bun install
```

Create `.env.local` (git-ignored) with:

```
VITE_SUPABASE_URL=http://127.0.0.1:55321
VITE_SUPABASE_PUBLISHABLE_KEY=<filled in after the next step>
# Server only (the API function and `bun run test:api-db`); never prefix it with VITE_.
HANDSHAKE_API_DATABASE_URL=postgresql://handshake_api:handshake_api_local@127.0.0.1:55322/postgres
# Sign-in emails go out through Resend (supabase/config.toml reads it). Without a real key, use the test accounts.
RESEND_API_KEY=re_…
```

Start Supabase. Always use `bun run db:start` or `bun run db:reset`, which load `.env.local`; the first
start pulls Docker images and takes a few minutes.

```bash
bun run db:start
```

Copy the **publishable key** from the output (or from `bunx supabase status`) into
`VITE_SUPABASE_PUBLISHABLE_KEY`.

### 3. Run the app

```bash
bun run dev
```

Open http://localhost:5173. Either sign in with the 6-digit code emailed to you, or skip email with the
**test accounts** on the Welcome screen: **Owner** (`owner@handshake.test`), **Payee**
(`payee@handshake.test`) and **Guest**. Switch between them under "Test accounts (local)" in the account menu.
They exist only in `bun run dev` against a local Supabase. Until a sending domain is verified in Resend,
emailed codes only reach the Resend account's own address.

The design kit (every primitive and figure) is at http://localhost:5173/kit, in development only.

### Local ports

Shifted from Supabase's defaults so this stack runs beside Pholio's. Don't move them back to 543xx.

| Service         | Port                                                |
| --------------- | --------------------------------------------------- |
| Vite dev server | 5173                                                |
| Supabase API    | 55321                                               |
| Postgres        | 55322                                               |
| Supabase Studio | 55323 (http://127.0.0.1:55323)                      |
| Mailpit         | 55324 (unused while auth email goes through Resend) |

## Checks

A change is done when these exit 0 (CI runs the same on every pull request):

```bash
bun run typecheck
```

```bash
bun test
```

```bash
bun run build
```

For SQL changes, also run the pgTAP tests against the local stack (Supabase must be running):

```bash
bun run test:db
```

| Command                                | What it does                                                                |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `bun run db:reset`                     | Rebuild the local database from `supabase/migrations/`                      |
| `bun run test:api-db`                  | The API's store contract suite against the local Postgres                   |
| `bun run api:lint`                     | Lint `docs/api-v1.openapi.yaml`                                             |
| `bun run gen:*-cases`, `gen:pull-keys` | Regenerate the pgTAP files from the shared case tables in `tests/fixtures/` |
| `bun run format`                       | Prettier (tabs, width 120, CRLF)                                            |

## Mobile

The native apps bundle the built site, so they open with no connection. Generate the platform folders with
the scripts, never by hand.

```bash
bun run mobile:add:android
```

```bash
bun run mobile:sync
```

```bash
bun run mobile:open:android
```

On an emulator or phone, `127.0.0.1` is the device itself: point `VITE_SUPABASE_URL` at your computer's LAN
address before `mobile:sync`. iOS uses the same steps with `ios` (needs a Mac with Xcode).

## Troubleshooting

- **`db:start` fails on a port:** another Supabase stack is using it. Stop it with `bun run db:stop` in
  that project, or `bunx supabase stop --all`.
- **Signed in but no groups arrive:** the publishable key in `.env.local` is from an older stack. Copy it
  again from `bunx supabase status` and restart `bun run dev`.
- **After `db:reset` the app shows old data:** the device still has its local copy. Sign out (which clears
  it) or clear the site's storage in DevTools.

## Where to read next

| Document                                                   | What it covers                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)                                   | Project rules: offline-first data flow, database rules, conventions |
| [`docs/architecture.md`](docs/architecture.md)             | System design, ADRs, module map                                     |
| [`docs/shared-ledger-spec.md`](docs/shared-ledger-spec.md) | What the app does: people, bills, debts, handshakes, guests         |
| [`docs/design.md`](docs/design.md)                         | UI rules, tokens and components                                     |
| [`docs/api-v1.md`](docs/api-v1.md)                         | The read-only API for Pholio (with `api-v1.openapi.yaml`)           |
| [`docs/chat-spec.md`](docs/chat-spec.md)                   | Group chat, live updates and push (being revisited: issue #8)       |
| [`docs/PRODUCT.md`](docs/PRODUCT.md)                       | Who it's for, principles and voice                                  |
