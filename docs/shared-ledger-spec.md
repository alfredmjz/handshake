# Shared ledger: people, bills, payments, guests, conflicts, completing a group and the Pholio API

- **Status:** Agreed for the MVP (third draft: every open decision answered, no admin role; system design
  and build handoffs in `docs/architecture.md`, the API contract in `docs/api-v1.md`)
- **Created:** 2026-11-03
- **Updated:** 2026-11-03
- **Author:** Claude Code, for Alfred Mah
- **Estimated Time:** about 10½ days, in seven slices that each ship on their own (see Implementation Guide)

## Quick Context

What Handshake has today (scaffold, 2026-11-03):

- Groups and members. The person who creates a group is its only member, with role `owner`.
- Every change is a mutation (`src/lib/sync/types.ts`). `mutate()` applies it to Dexie and queues it;
  `push_changes()` (`supabase/migrations/003_sync.sql`) applies the queue on the server, and
  `pull_changes(cursors)` returns rows past each group's version. Screens read only from Dexie.
- `src/lib/money.ts`: amounts as integers, `parseAmount`, `formatAmount`, `splitEvenly`.
- Sign-in with a 6-digit email code.

This spec adds what makes the app useful: the people in a group, bills and how they are split, who owes
whom, paying back, inviting friends (as members or guests), resolving edit conflicts, checking off who
has paid and completing a group, and a read-only API that Pholio calls.

**Handshake stays a standalone app with its own UI.** It never calls Pholio. Pholio reads from
Handshake through Handshake's API, with a token the person creates in Handshake and can revoke. Pholio's
old draft `docs/social-finance-spec.md` (2025-12-14) tracked debts privately inside Pholio; Handshake
replaces that approach. Its trip allowance idea moves to the trip planning spec.

## Problem Statement

A group can be created, but nothing can be recorded in it. A friend group on a trip needs to:

1. Add everyone, including friends who never install the app.
2. Record a bill as items: each item has who paid it and who shares it, and the app works out who owes
   whom.
3. See who owes whom, and the fewest payments that settle everyone up.
4. Record a payback ("Sam paid Alex $30"). No money moves; Handshake only keeps the record.
5. Invite friends with a link. Each one either creates an account or continues as a guest.
6. Sort out the rare case where two people edit the same bill before syncing, together, like a merge
   conflict.
7. Do all of it with no signal, except joining a group, which needs the server.
8. Let the owner check off who has paid, then mark the group completed.
9. Let Pholio read what the person paid and owes, without Handshake knowing anything about Pholio.

## How the money works

All amounts are dollars and cents, stored as whole cents. The app shows `$` and nothing else: no
currency codes, pickers or exchange rates.

### Entries and shares

Everything recorded in a group is an **entry**: an expense (a bill) or a payment. An entry has one
**share** per member it involves, saying how much that member **paid** and how much they **owe** from it.

- For every entry, Σ paid = total and Σ owed = total.
- A member's **balance** is Σ paid − Σ owed over the group's entries that are not deleted. Positive:
  others owe them. Negative: they owe. A group's balances always add up to 0.

Example with Alex, Sam and Jo:

| Entry                                   | Alex                                | Sam                     | Jo                      |
| --------------------------------------- | ----------------------------------- | ----------------------- | ----------------------- |
| Dinner $90.00, Alex paid, split equally | paid 90.00, owes 30.00 → **+60.00** | owes 30.00 → **−30.00** | owes 30.00 → **−30.00** |
| Payment: Sam paid Alex $30.00           | owes 30.00 → **+30.00**             | paid 30.00 → **0.00**   | **−30.00**              |

A payment is an entry where the person paying back "paid" and the person receiving "owes", which moves
both balances towards zero.

### Bills are made of items

A bill holds one or more **items**. Each item has an amount, **one payer**, and the people it is
**split among**, equally. A simple expense is a bill with one item; the editor only shows items when
someone taps **Add item**.

- Different items can have different payers: Item A paid by Person 1, Item B paid by Person 2.
- An amount one person owes in full ("Jo's drink, $7") is an item split among just that person. So there
  is no separate "exact amounts" mode: one item per person does the same job. Percentages and weighted
  shares (a couple counting as 2) are left out of this version (decision 2).

The stored shares (paid and owed per member) are the result. The items are kept so the editor reopens
as it was left, and so the server can check the shares (decision 3).

### Rounding

1. **Paid** is exact: each member's paid amount is the sum of the items they paid.
2. **Owed** is worked out across the whole bill, not item by item: each person's exact share is the sum
   of item amount ÷ number of people splitting it, over the items they are in.
3. Each person's exact share is **rounded once, normally, to the cent** (half a cent rounds up).
4. If the rounded shares don't add up to the total, **the payer covers the difference**: their own share
   takes the missing or extra cents. With several payers, it is the one who paid the most; a tie goes to
   whoever paid the earliest item among them.
5. If that would make the payer's share negative (they paid for others and aren't sharing), the extra
   cents come off the other shares instead, one cent each, starting with the shares that were rounded up
   the most; ties go to whoever is listed first on the bill.

The device does this with whole numbers only: the exact shares are fractions with a common denominator,
so nothing is ever a float.

Examples (the last two are pinned in the Testing Checklist):

| Bill                                                                           | Result                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **Scenario A:** $50.00, split evenly by 5                                      | $10.00 each                                                                    |
| $10.00 split by Alex, Jo and Sam; Sam paid                                     | Alex $3.33, Jo $3.33. Sam's share is $3.34: Sam covers the 1¢                  |
| $20.00 split by Alex, Jo and Sam; Sam paid                                     | Alex $6.67, Jo $6.67. Sam's share is $6.66: the extra 1¢ comes off Sam's share |
| **Scenario B:** Item 1 $5 and Item 2 $10 split by all 3, Item 3 $8 by Person 3 | Person 1 $5, Person 2 $5, Person 3 $13 (total $23)                             |
| **Scenario C:** Items 1 and 2 as in B, Item 3 $8 split by Persons 2 and 3      | Person 1 $5, Persons 2 and 3 $5 + $4 = $9 each (total $23)                     |

Rounding once per person matters: two $10 items split three ways give each person exactly $6.67 (6.666…
rounded once), where rounding per item would give $3.33 + $3.33 = $6.66.

In the editor and on the entry, the line reads "$3.33 each"; Sam's line in the detail says "$3.34, incl.
1¢ rounding", so nobody is surprised by the odd cent.

### Who pays whom (several payers)

Each person's balance in a bill is paid − owed. Example: groceries $60 paid by Person 1 and gas $40 paid
by Person 2, both split among Persons 1–5:

| Person | Paid   | Owes   | Balance    |
| ------ | ------ | ------ | ---------- |
| 1      | $60.00 | $20.00 | **+40.00** |
| 2      | $40.00 | $20.00 | **+20.00** |
| 3      | $0.00  | $20.00 | **−20.00** |
| 4      | $0.00  | $20.00 | **−20.00** |
| 5      | $0.00  | $20.00 | **−20.00** |

Settling up: Person 3 pays Person 1 $20, Person 4 pays Person 1 $20, Person 5 pays Person 2 $20.

### Settling up

Suggested payments come from the balances with a greedy match: the person who owes the most pays the
person owed the most, as much as fits, and repeat. That never takes more than n − 1 payments for n
people. Ties go alphabetically by name. Tapping a suggestion opens Record payment, filled in.

Example: Alex +60, Sam −10, Jo −50 gives "Jo pays Alex $50" and "Sam pays Alex $10".

When the group is done, the owner opens the **settle-up tracker**, ticks off each person as they pay
(each tick records their payments, decision 10), and then **completes the group** (decision 11).

## Design Decisions

### 1. One table for expenses and payments

- **Chosen Solution:** `ledger_entries` with `kind` (`expense` or `payment`), and `ledger_shares`
  holding paid and owed per member.
- **Why:** a balance is one sum over one table, and a payment is just an entry with one payer and one
  receiver. History, sync, validation and the API have one code path.
- **Alternatives considered:** a separate `settlements` table, which doubles the balance, history and
  sync code.

### 2. A bill is a list of items, each split equally

- **Chosen Solution:** an expense holds items; each item has an amount, one payer, and a set of people
  who split it equally. Several payers on one bill means several items.
- **Why:** it covers the owner's cases (one shared total, items owed by one person, items shared by
  some, different payers) with one simple control per item. Exact amounts per person are items for one
  person, so they need no mode of their own.
- **Alternatives considered:** split methods on the whole bill (equal, exact, percent, shares), as in
  the first draft; it can't express "Item 3 is only Jo's" without arithmetic by hand. Weights per person
  can be added to items later without changing the shares.

### 3. Store the resulting shares; keep items for editing; the server re-checks

- **Chosen Solution:** shares store the final cents. The entry keeps its items as JSON (`items`).
  `push_changes()` works out the shares from the items with the same rounding rule
  (`private.compute_shares()`) and rejects the entry if they differ.
- **Why:** balances never depend on re-running the rounding, and every device and the API add up the
  same stored rows. Re-checking on the server means a buggy or old device can't store shares that don't
  match the bill.
- **Trade-off:** the rounding rule exists twice, in TypeScript and SQL. Both are tested against the same
  pinned numbers. Postgres `NUMERIC` keeps the SQL version exact.
- **Alternatives considered:** checking only that the sums match (lets wrong-but-balanced shares
  through); a separate `ledger_items` table (more rows and sync code for data that is only read by the
  editor).

### 4. Rounding: once per person, the payer covers the difference

- **Chosen Solution:** the rule in "Rounding" above. Confirmed by the owner on 2026-11-03: in $10 split
  three ways, the two who pay back each pay $3.33 and the payer absorbs the cent. The exact integer
  algorithm is in `docs/architecture.md` §9.
- **Why:** it is what people expect when they check a bill with a calculator: everyone else's share is
  their exact share, rounded normally. The person who paid is the one holding the receipt, so they take
  the odd cent.
- **Alternatives considered:** the largest-remainder method from the first draft (also exact, but the
  cent can land on anyone); rounding per item (drifts a cent per item, as the $6.66 example shows).

### 5. Balances are worked out on the device

- **Chosen Solution:** pure functions in `src/lib/ledger.ts` read local rows, including changes that
  have not synced yet. The API (decision 14) imports the same functions.
- **Why:** they must work offline, and one implementation means the app and Pholio always agree.

### 6. Edit conflicts are kept and resolved by the group

- **Chosen Solution:**
  - `entry.update` and `entry.delete` carry `baseVersion`, the `row_version` the person started from.
  - When the stored entry is newer **and** was last changed by someone else, the server does **not**
    apply the change and does **not** reject it. It stores it in `entry_conflicts` (the version the
    person started from, their version, who made it) and keeps the current version. The mutation counts
    as applied, so it leaves the outbox.
  - Every device pulls the conflict. Members see a popup: "Dinner was changed by Alex and Sam at the
    same time. Resolve now / Later". The entry shows a **Needs resolving** badge until then.
  - The resolver shows the two versions side by side (description, date, notes, and each item: amount,
    payer, people), with the changed fields marked. Per field, pick left or right, or edit; or take one
    whole version. Saving sends `conflict.resolve` with the final entry.
  - **Balances use the current version until the conflict is resolved.**
  - **Any full member can resolve** (owner or member). Guests see the badge and "Waiting for a
    member to resolve this", but can't resolve.
  - A delete against a newer edit, or an edit against a deleted entry, is a conflict too. The resolver
    then offers "Keep it deleted" or "Restore this version".
  - Another stale edit while a conflict is open adds a second conflict; the resolver works through them
    oldest first.
  - Two people resolving the same conflict: the first wins; the second is rejected with `HS409` and
    their device shows "Alex already resolved this", with the result.
- **Why:** money edits are never lost silently, nobody is told to redo their work, and the people who
  were there decide.
- **Trade-off:** one person editing on two devices while offline is not a conflict (same `updated_by`);
  the last one wins.
- **Alternatives considered:** rejecting the later edit (the first draft; the owner prefers resolving);
  last write wins (loses edits silently); merging automatically (wrong for split amounts).

The device mirrors the rule in `mergePull`: an unsent update whose entry is now newer and was changed
by someone else is not replayed on top; the server turns it into a conflict when it is pushed.

### 7. Shares and items travel with their entry

- **Chosen Solution:** a pull returns each changed entry with its items and all of its shares, and the
  device replaces that entry's shares. In Dexie, shares and items live inside the entry record.
- **Why:** changing a split adds and removes shares. Sending them with the entry means removed shares
  need no deletion rows of their own.

### 8. Roles and permissions

- **Chosen Solution:** three roles on `group_members.role`: `owner`, `member`, `guest`. **There is no
  admin role** (owner, 2026-11-03). A **non-member** is a person the owner added by name who hasn't joined
  yet (a member row with no `user_id`).

| Action                                                                    | Owner | Member | Guest           |
| ------------------------------------------------------------------------- | ----- | ------ | --------------- |
| View entries, balances and people                                         | ✓     | ✓      | ✓               |
| Add entries and payments                                                  | ✓     | ✓      | ✓               |
| Remove entries                                                            | ✓     | ✓      | Ones they added |
| Edit entries                                                              | ✓     | ✓      |                 |
| Resolve conflicts                                                         | ✓     | ✓      |                 |
| Rename themselves                                                         | ✓     | ✓      | ✓               |
| Rename the group, add non-members, rename anyone, make and revoke invites | ✓     |        |                 |
| Remove non-members, guests and members                                    | ✓     |        |                 |
| Use the settle-up tracker; complete or reopen the group                   | ✓     |        |                 |
| Delete the group                                                          | ✓     |        |                 |
| Leave the group                                                           | ✓     | ✓      | ✓               |

- When the owner leaves, ownership passes to the full member who joined first (`joined_at`, then id).
  When the last full member leaves, the group is deleted, even if guests remain.
- Removing someone keeps their history: their shares stay, their balance shows with "(left)" until it
  is settled, and pickers stop offering them. Nothing deletes entries except deleting them.
- Deleting a group is a soft delete; it disappears for everyone on their next sync.
- **Why:** the owner decided that adding people and completing the group are their job alone. Entries
  stay open to everyone, because friend groups trust each other and the app works best when whoever has
  the receipt adds it.
- **Later:** a "Make owner" handover, so an owner who is away can pass the job on (a new mutation, no
  schema change).

### 9. Non-members, invite links and guests

- **Chosen Solution:**
  - The owner adds non-members by name, so bills can include them at once.
  - An invite link is valid for **14 days**, can be used many times, and can be revoked. It can be tied
    to a non-member ("Invite Jo"), so whoever opens it becomes Jo.
  - Opening the link shows the group and two choices: **Create an account** (6-digit email code; joins
    as a member) or **Continue as guest** (joins as a guest, no email).
  - Guests use **Supabase anonymous sign-in** (`signInAnonymously()`). An anonymous user is a real
    `auth.users` row with the `authenticated` role and an `is_anonymous` claim in its token, so sync,
    RLS and `push_changes()` work unchanged; the guest role limits what they can do.
  - A guest keeps their data by adding an email later ("Keep my data"): `updateUser({ email })`, then
    the 6-digit code. The user id stays the same, so their member rows and history stay theirs. An online
    function `upgrade_guest()` then turns their `guest` rows into `member`.
  - Anonymous users can't create groups (`group.create` checks `is_anonymous`).
  - The token is 32 random bytes in base64url, made on the device. The server stores only its SHA-256
    (`token_hash`). The creator's device keeps the token so it can share the link again.
  - Creating a link works offline (it is a mutation). Share is enabled once the invite has synced.
  - Joining needs a connection and uses two functions instead of mutations, because someone who is not
    yet a member cannot push or pull for the group: `preview_invite(token)` and
    `join_group(token, claim_member_id, display_name)`. `preview_invite` also works signed out, so the
    join screen can show the group before the person picks account or guest.
- **Why multi-use:** a friend group shares one link in its group chat.
- **Why anonymous sign-in:** guests get the same offline sync as everyone else, with no second auth
  system, and upgrading keeps the same user.
- **Setup:** `supabase/config.toml` sets `enable_anonymous_sign_ins = true` and
  `enable_manual_linking = true` (needed to add an email to an anonymous user). Production also needs
  CAPTCHA (Cloudflare Turnstile) on anonymous sign-ins; the default limit is 30 per hour per IP.
- **Alternatives considered:** guests without any sign-in (a link that acts as a password; would need a
  second permission path through every function); one link per person (more tapping).

### 10. Settle-up tracker: ticking someone off records their payments

- **Chosen Solution:**
  - Before completing, the owner opens **Settle up**. It lists each person with what they
    owe or are owed right now, and the suggested payments under each one ("owes $20.00 to Person 1").
  - **Ticking someone who owes records their suggested payments as payment entries**, one per payment,
    dated today, with `recorded_via = 'settle_up'`. Their balance drops to $0, so they show as **Paid**.
    Ticking someone who is owed records every suggested payment to them, and they show as **Received**.
  - **Unticking** deletes the settle-up payments that involve that person.
  - The ticks are not stored separately: a row is ticked when the person's balance is $0. So a payment
    recorded the normal way ticks the row too, and a new expense added later unticks it.
  - If someone paid differently from the suggestion (Jo paid Sam, not Alex), the owner records that
    payment with Record payment instead, and the tracker follows.
  - The tracker shows "3 of 5 settled" at the top.
- **Why:** one source of truth. Balances, the Entries list and the Pholio API all agree with the
  tracker, because a tick is a real payment. A separate checklist could say "paid" while balances still
  said "owes $20".
- **Trade-off:** a tick records the full amount. Partial payments go through Record payment.
- **Alternatives considered:** ticks as checklist marks only (a second, disagreeing record of who has
  paid); ticks that ask for each payment's details (slower, and Record payment already does that).

### 11. Completing a group deletes guests' logins

- **Chosen Solution:**
  - **"Completed" applies to the whole group**, not to a single bill. A friend group or trip ends as a
    whole, and a guest belongs to a group, so deleting a guest per bill doesn't make sense.
  - The owner taps **Complete group** at the bottom of the settle-up tracker. If anyone
    still owes money, the confirmation says so ("Jo still owes $20.00. Complete anyway?"). It also names
    the guests who will lose access: "Kim and Lee are guests. They will lose access to this group. Their
    names and history stay."
  - `group.complete` sets `completed_at` and `completed_by_member_id`. A completed group is read-only:
    nobody can add, edit or delete entries or make invites (`HS403`). It moves to a **Completed**
    section on the Groups list.
  - In the same transaction, every guest in the group who hasn't added an email has their data deleted:
    - Their member row becomes a name-only non-member again (`user_id` NULL, role `member`), so every
      entry and balance still adds up and shows their name.
    - If they are no longer in any group, their anonymous `auth.users` row is deleted, which also
      removes their profile and `sync_mutations` rows. A guest still in another group keeps their login
      there.
    - Entries record who added and edited them by **member id**, not user id, so "Added by Kim"
      survives.
  - Guests who added an email before completion are members by then, so nothing happens to them.
  - **Reopen group** (owner) makes it editable again. Deleted guest logins don't come back; the
    owner can invite those names again, and whoever joins takes over the non-member and its history.
  - Completing works offline like any mutation; the guests lose access when it reaches the server.
- **Why:** the owner's rule: the split is completed when the owner marks it so, after checking who has
  paid. Doing it in the same transaction means there is no window where a completed group still has
  guests.
- **Alternatives considered:** completing single bills (a guest can't lose access per bill); deleting
  guests on a timer (not what the owner asked for); deleting the guest's shares too (balances would
  stop adding up).

### 12. Join links

- **Chosen Solution:** a `/join/:token` route. Someone signed out picks account or guest first and lands
  back on the join screen (the URL is kept). The native apps need universal links and App Links, which
  need a domain and store setup; until then, the Groups page has a "Have an invite link?" box to paste
  it into.

### 13. Dollars only

- **Chosen Solution:** every amount is cents, shown with `$`. `src/lib/money.ts` loses its currency
  argument: `parseAmount(input)` accepts up to 2 decimals, and `formatAmount(cents)` gives "$1,234.50"
  and "−$3.33". `minorUnitDigits()` and `splitEvenly()` go (the new rounding lives in `computeShares()`
  in `src/lib/ledger.ts`). `groups.base_currency` stays in the database, unused, because migrations are
  additive; the device stops showing it.
- **Why:** the owner's groups use dollars, and currency was only ever shown, never converted.

### 14. The API runs as Vercel functions in this repo

- **Chosen Solution:** `api/v1/[...path].ts` in this repo, deployed with the app on Vercel (Bun
  runtime; Node 26 LTS as the fallback, ADR-006), a thin adapter over a framework-free handler in `src/server/api-v1/`. It connects to Postgres
  through the Supabase connection pooler as a dedicated role `handshake_api` that can only `EXECUTE` the
  functions in an `api` schema. **Each `api.v1_*` function takes the token's hash, not a user id**, and
  authenticates and rate-limits inside the same call, so the role's password alone reads nothing. The
  handler imports the same pure functions from `src/lib/ledger.ts` as the app. The full decision record,
  with the alternatives weighed, is ADR-001 to ADR-004 in `docs/architecture.md`.
- **Why:** a plain HTTP contract that Handshake owns. Pholio never sees Supabase, PostgREST, the
  Supabase URL or any Supabase key, and Handshake's backend can change later without breaking Pholio.
  The only Supabase-specific part is the connection string.
- **Alternatives considered:**
  - A Supabase Edge Function: also plain HTTP, but Deno, deployed and tested separately, and tied to
    Supabase.
  - Exposing PostgREST or RPC to Pholio: couples Pholio to Handshake's tables and to Supabase.
  - The service-role key in the functions: works, but bypasses RLS; a role that can only run the `api`
    functions is safer.

### 15. Pholio is authorised with a connection token

- **Chosen Solution:**
  - In Handshake, **Settings → Connected apps → Connect an app**, the person names the token ("Pholio")
    and gets it **once**: `hsk_` + 32 random bytes in base64url (43 characters). They paste it into Pholio.
  - The server stores only its SHA-256 (`api_tokens.token_hash`), plus the name, the scope (`read`),
    `last_used_at` and `revoked_at`. Tokens don't expire on their own; the person revokes them. At most
    10 live tokens per person.
  - Pholio sends `Authorization: Bearer hsk_…`. A token sees exactly what its owner sees, read-only.
  - Creating, listing and revoking tokens are online-only functions (`create_api_token`,
    `list_api_tokens`, `revoke_api_token`) called through `supabase-transport.ts`, like joining.
  - Guests can't create tokens.
- **Why:** simple, revocable, nothing secret stored, and no Pholio-specific code in Handshake.
- **Later:** OAuth 2.1 with PKCE ("Sign in with Handshake" from Pholio), so nobody copies a token. The
  API contract stays the same; only how the bearer token is issued changes.

### 16. Rejection codes

- **Chosen Solution:** each rejected mutation comes back as `{ id, code, reason }`, with `code` from
  SQLSTATE. Handshake's own codes: `HS403` not allowed, `HS404` not found (invites), `HS409` conflict
  already resolved, `HS422` invalid. The device shows a toast per code, with `reason` as the detail.
  The scaffold's existing `group.rename` membership check moves to `HS403`. The `api.v1_*` functions add
  `HS401` (unknown or revoked token) and `HS429` (rate limited), which the API maps to HTTP 401 and 429.

## Data Model

### Server

`groups` gains `completed_at TIMESTAMPTZ NULL` and `completed_by_member_id UUID NULL → group_members`.

`group_members` changes:

- `role` allows `owner`, `member`, `guest` (the check constraint is dropped and re-added).
- Gains `joined_at TIMESTAMPTZ`, set whenever `user_id` is set (backfilled from `created_at`).

`ledger_entries`

| Column                 | Type                 | Notes                                                 |
| ---------------------- | -------------------- | ----------------------------------------------------- |
| `id`                   | UUID PK              | Made on the device                                    |
| `group_id`             | UUID → groups        |                                                       |
| `kind`                 | TEXT                 | `expense` or `payment`                                |
| `description`          | TEXT                 | 1–120 characters; payments default to "Payment"       |
| `amount_cents`         | BIGINT               | > 0 and ≤ 10¹²; the bill total                        |
| `items`                | JSONB NULL           | Expenses only; see below                              |
| `entry_date`           | DATE                 | The day it happened, chosen by the person             |
| `notes`                | TEXT NULL            | ≤ 1000 characters                                     |
| `recorded_via`         | TEXT NULL            | `settle_up` for payments ticked in the tracker        |
| `created_by_member_id` | UUID → group_members | Member ids, so history survives a guest being deleted |
| `updated_by_member_id` | UUID → group_members | Used by the conflict rule (decision 6)                |
| `created_at`           | TIMESTAMPTZ          | Server time                                           |
| `updated_at`           | TIMESTAMPTZ          | Server time                                           |
| `deleted_at`           | TIMESTAMPTZ NULL     |                                                       |
| `row_version`          | BIGINT               | From `private.next_group_version()`                   |

Each item in `items`: `{ id, description, amountCents, paidBy, splitAmong }`, where `paidBy` is a member
id and `splitAmong` a list of member ids in the order shown. `description` is optional (up to 60
characters). At most 50 items per bill.

`ledger_shares` (primary key `entry_id, member_id`)

| Column                     | Type                                    | Notes                    |
| -------------------------- | --------------------------------------- | ------------------------ |
| `entry_id`                 | UUID → ledger_entries ON DELETE CASCADE |                          |
| `group_id`                 | UUID → groups                           | Copied for RLS and pulls |
| `member_id`                | UUID → group_members                    |                          |
| `paid_cents`, `owed_cents` | BIGINT ≥ 0                              |                          |

`entry_conflicts`

| Column                  | Type                      | Notes                                       |
| ----------------------- | ------------------------- | ------------------------------------------- |
| `id`                    | UUID PK                   | The mutation id that caused it              |
| `group_id`              | UUID → groups             |                                             |
| `entry_id`              | UUID → ledger_entries     |                                             |
| `base_version`          | BIGINT                    | What the proposer started from              |
| `base`                  | JSONB                     | That version of the entry, items and shares |
| `proposed`              | JSONB NULL                | The proposer's version; NULL for a delete   |
| `proposed_by_member_id` | UUID → group_members      |                                             |
| `created_at`            | TIMESTAMPTZ               |                                             |
| `resolved_at`           | TIMESTAMPTZ NULL          |                                             |
| `resolved_by_member_id` | UUID NULL → group_members |                                             |
| `resolution`            | TEXT NULL                 | `kept_current`, `took_proposed` or `merged` |
| `row_version`           | BIGINT                    |                                             |

The current version is the entry itself, so the resolver compares `base`, the entry and `proposed`
(three-way, which is how it marks what each side changed). `base` is copied from
`ledger_entry_versions` (entry id, version, snapshot), where the server keeps the last 20 versions of
each entry. If the base version is older than that, `base` is NULL and the resolver compares the two
versions without marking changes.

`group_invites`

| Column            | Type                      | Notes                              |
| ----------------- | ------------------------- | ---------------------------------- |
| `id`              | UUID PK                   | Made on the device                 |
| `group_id`        | UUID → groups             |                                    |
| `token_hash`      | TEXT UNIQUE               | SHA-256 hex; never sent to devices |
| `claim_member_id` | UUID NULL → group_members | The non-member this link is for    |
| `created_by`      | UUID → users              |                                    |
| `created_at`      | TIMESTAMPTZ               |                                    |
| `expires_at`      | TIMESTAMPTZ               | 14 days                            |
| `revoked_at`      | TIMESTAMPTZ NULL          |                                    |
| `row_version`     | BIGINT                    |                                    |

`api_tokens` (not synced; no group)

| Column              | Type                 | Notes                                       |
| ------------------- | -------------------- | ------------------------------------------- |
| `id`                | UUID PK              |                                             |
| `user_id`           | UUID → users CASCADE |                                             |
| `name`              | TEXT                 | 1–60 characters, e.g. "Pholio"              |
| `token_hash`        | TEXT UNIQUE          | SHA-256 hex                                 |
| `scope`             | TEXT                 | `read` (the only one in v1)                 |
| `created_at`        | TIMESTAMPTZ          |                                             |
| `last_used_at`      | TIMESTAMPTZ NULL     | Updated by every API request                |
| `revoked_at`        | TIMESTAMPTZ NULL     |                                             |
| `rate_window_start` | TIMESTAMPTZ NULL     | Start of the current one-minute rate window |
| `rate_window_count` | INT                  | Requests in that window (limit 60)          |

Members get `SELECT` on the group tables through `is_group_member()`; on `group_invites`, the grant
leaves out `token_hash`. Clients get nothing on `api_tokens` or `ledger_entry_versions`. Indexes:
`(group_id, row_version)` on each synced table, `(group_id, entry_date)` on entries, `(member_id)` on
shares, `(entry_id) WHERE resolved_at IS NULL` on conflicts.

### Device (Dexie version 2)

- `entries`: `id, groupId, [groupId+entryDate]`; each record holds its `items` and `shares`.
- `conflicts`: `id, entryId, groupId`.
- `invites`: `id, groupId`.
- `inviteTokens`: `inviteId`; local only, never synced.
- `keepOnlyGroups` also drops the entries, conflicts, invites and tokens of groups that are gone.

## Sync Changes

### New mutations

| Type               | Fields                                                                                             | Who                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `member.add`       | `memberId, groupId, displayName`                                                                   | Owner                                               |
| `member.rename`    | `memberId, groupId, displayName`                                                                   | Yourself; the owner renames anyone                  |
| `member.remove`    | `memberId, groupId`                                                                                | Owner (see decision 8); yourself to leave           |
| `group.rename`     | `groupId, name` (exists today)                                                                     | Owner                                               |
| `group.delete`     | `groupId`                                                                                          | Owner                                               |
| `group.complete`   | `groupId`                                                                                          | Owner                                               |
| `group.reopen`     | `groupId`                                                                                          | Owner                                               |
| `entry.create`     | `entryId, groupId, kind, description, amountCents, entryDate, notes, items, shares[], recordedVia` | Everyone, guests included; `recordedVia` owner only |
| `entry.update`     | Same as `entry.create`, plus `baseVersion`                                                         | Owner, member                                       |
| `entry.delete`     | `entryId, groupId, baseVersion`                                                                    | Owner, member; guests their own                     |
| `conflict.resolve` | `conflictId, entryId, groupId, resolution, entry` (the final version, or `deleted: true`)          | Owner, member                                       |
| `invite.create`    | `inviteId, groupId, token, claimMemberId, expiresAt`                                               | Owner                                               |
| `invite.revoke`    | `inviteId, groupId`                                                                                | Owner                                               |

Each share is `{ memberId, paidCents, owedCents }`. `group.create` stops sending `baseCurrency`; the
server keeps the column default. There is no `member.setRole` (no admin role).

`private.apply_mutation()` dispatches to one private function per type instead of growing one `CASE`.

### Entry checks on the server

Rejected with `HS403`: the caller is not an active member, the group is deleted or completed, or the
caller's role can't do this (decision 8).

Rejected with `HS422`:

- A share's member, an item's payer or someone in `splitAmong` is not in this group, or a member appears
  twice.
- An amount is zero, negative or not a whole number.
- An expense with no items, an item with nobody to split among, or items that don't add up to the total.
- Shares that differ from `private.compute_shares(items)`.
- A payment that is not exactly two different members: one paid the amount and owes 0, the other owes
  the amount and paid 0, with no items.
- An update that changes `group_id` or `kind`.

A stale edit by someone else becomes a conflict (decision 6), not a rejection. Rejected with `HS409`:
resolving a conflict that is already resolved. The device runs the same checks before saving, so these
rejections only happen when devices disagree.

Updating or deleting an entry the server never received (its create was rejected) is accepted and does
nothing, so one bad entry doesn't produce two error toasts.

### Pull additions

Each group in `changes` gains `entries` (each with its `items` and `shares`), `conflicts` and `invites`
(without `token_hash`). Groups gain `completed_at` and `completed_by_member_id`; members gain
`joined_at`. Deleted entries come through with `deleted_at` set. A guest removed by completion is no
longer a member, so their next pull drops the group from their device.

### Online-only functions

All are `SECURITY DEFINER` and for signed-in users only (anonymous users included unless noted). Exact
return shapes are in `docs/architecture.md` §11.2.

- `preview_invite(p_token TEXT)` returns the group name, who made the link, the unclaimed non-members
  (id and name), and whether the caller is already in the group. Expired, revoked or unknown tokens raise
  `HS404`. **Also callable signed out** (`anon`), so the join screen can show the group first; the token
  is 256 random bits, so it can't be guessed.
- `join_group(p_token TEXT, p_claim_member_id UUID DEFAULT NULL, p_display_name TEXT DEFAULT NULL)`
  returns the group id. It does nothing if the caller is already in the group. The role is `guest` when
  the caller is anonymous, else `member`. If the link is tied to a non-member, or one is chosen, the
  caller takes it over (it must be unclaimed and not removed); otherwise a member is added under
  `p_display_name`, or the caller's profile name when that is empty (guests have no useful profile name).
  Someone who left and comes back gets their old member row back, with its history. It stamps the group's
  next version, so other devices pull the change.
- `upgrade_guest()` (the caller must no longer be anonymous) turns the caller's `guest` rows into
  `member`, copies their new email into their profile, and stamps each group's next version.
- `create_api_token(p_name TEXT)` returns `{ id, token, name, createdAt }`, the token only this once.
  `list_api_tokens()` and `revoke_api_token(p_id UUID)`. Not for anonymous users.

## Handshake API v1 (for Pholio)

Read-only, versioned HTTP. Base URL: `https://<handshake domain>/api/v1`. JSON, camelCase, amounts in
whole cents (`…Cents`), dates `YYYY-MM-DD`, timestamps ISO 8601 UTC. Every response is about the person
who owns the token: what they paid, what they owe, and their balance.

### Endpoints

| Method and path                 | Returns                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /me`                       | `{ userId, displayName }`                                                                            |
| `GET /groups`                   | `{ groups }`: `id, name, role, memberId, paidCents, owedCents, balanceCents, completedAt, updatedAt` |
| `GET /groups/{groupId}`         | One group as above, plus `settleUp`: the suggested payments that involve the person                  |
| `GET /groups/{groupId}/entries` | That group's entries, as a change feed (below)                                                       |
| `GET /entries`                  | Entries across all their groups, as a change feed; the call Pholio uses to stay in sync              |

An entry: `{ id, groupId, kind, description, entryDate, totalCents, involved, paidCents, owedCents,
netCents, hasConflict, createdAt, updatedAt, deletedAt }`, where the three amounts are the person's own
share (0 and `involved: false` when they aren't in it) and `netCents` = paid − owed. Items and other
people's shares are not included in v1.

Entry lists are a **change feed**: they take `cursor` and `limit` (default 100, at most 500) and return
`{ entries, nextCursor, hasMore, removedGroupIds }`. The cursor is opaque and holds, per group, the last
version Pholio has seen, like the device's pull cursors; this replaces the first draft's `updatedSince`
timestamp, which could skip rows that commit out of timestamp order (ADR-004 in `docs/architecture.md`).
Deleted entries come through with `deletedAt` set, so Pholio can remove them; `removedGroupIds` lists
groups the person has left or that were deleted. An entry with an open conflict is returned as its
current version with `hasConflict: true`, and again when the conflict is resolved.

The full contract, with every field, error and header, is `docs/api-v1.md` and
`docs/api-v1.openapi.yaml`; this section only summarises it.

Example: `GET /groups/{id}` for Sam after the $10.00 dinner Sam paid, split by Alex, Jo and Sam:

```json
{
	"id": "…",
	"name": "Banff trip",
	"role": "member",
	"memberId": "…",
	"paidCents": 1000,
	"owedCents": 334,
	"balanceCents": 666,
	"completedAt": null,
	"updatedAt": "2026-11-03T18:20:00.000Z",
	"settleUp": [
		{ "fromMemberId": "…", "fromName": "Alex", "toMemberId": "…", "toName": "Sam", "amountCents": 333 },
		{ "fromMemberId": "…", "fromName": "Jo", "toMemberId": "…", "toName": "Sam", "amountCents": 333 }
	]
}
```

### Errors and limits

- Errors are `{ "error": { "code": "…", "message": "…" } }`: `401 invalid_token` (missing, unknown or
  revoked), `404 not_found` (including groups the person isn't in), `400 bad_request`, `405
method_not_allowed`, `429 rate_limited` (60 requests a minute per token, with `Retry-After`), `500
server_error`.
- Tokens only in the `Authorization` header, never in URLs.
- Responses are `Cache-Control: no-store`. CORS is open (`*`) because the API uses bearer tokens, not
  cookies; Pholio should still keep the token on its server.

### Versioning

- Within v1, changes are additive only: new endpoints, new optional parameters, new fields. Pholio must
  ignore fields it doesn't know.
- Anything breaking goes in `/api/v2`, and v1 keeps working for at least 6 months after v2
  ships.
- `docs/api-v1.md` is the contract Pholio's side is built against.

### How it is built

- `api/v1/[...path].ts`: one Vercel function that checks the token's format, hashes it, routes, and makes
  one call to an `api.v1_*(token_hash, …)` SQL function, which authenticates, rate-limits, updates
  `last_used_at` and returns the person's rows. Balances and `settleUp` come from `src/lib/ledger.ts`.
- `vercel.json` rewrites everything to `index.html` today; it must leave `/api/` alone, and so must the
  service worker's navigation fallback.
- Environment: `HANDSHAKE_API_DATABASE_URL` (the pooler URL for the `handshake_api` role), set only on
  the server. Nothing from Pholio is stored in Handshake.

## Screens

Built for 375px first and checked at 1440px, using the existing tokens and primitives. Pickers list
people alphabetically.

1. **Groups.** Each group shows your balance in it: "You're owed $60.00" (success colour), "You owe
   $30.00" (error colour) or "Settled up". Below the create box: "Have an invite link?" with a paste
   field. Guests can't create groups, so they see only the paste box.
   Completed groups are listed below, under **Completed**.
2. **Group.** The name, Rename (owner), and a menu with Leave group, and for the owner **Settle up and
   complete** and Delete group. A completed group shows "Completed on 3 Nov by Alex", has no add or edit
   buttons, and offers Reopen group to the owner. Two main buttons: **Add expense** and **Record
   payment**. A segmented control: **Balances | Entries | People**, opening on Entries.
   - **Entries:** newest first, grouped by day. A row shows the description, "Alex paid $90.00" (or
     "Alex and Sam paid $100.00"), and what it means for you: "You owe $30.00", "You lent $60.00" or
     "Not involved". Payments read "Sam paid Alex $30.00". Unsynced entries say "Not synced yet";
     conflicted ones show **Needs resolving**.
   - **Balances:** everyone's balance, you first, then Suggested payments, each with a Record button.
     Someone who left shows "(left)".
   - **People:** members (the owner labelled Owner), then guests, then "Not joined yet" non-members.
     The owner sees Add person, Remove, and invite links: create, copy, share (Web Share API, or the
     native share sheet), revoke, and the expiry date.
3. **Expense editor.** Full screen on phones, a dialog on desktop. Description, date (today), notes.
   One item to start: amount, **Paid by** (you first, then alphabetical), and **Split between** (a
   checkbox per person, everyone ticked). **Add item** turns it into a list of items, each with its own
   amount, payer and people, and a running total. Below: each person's result ("Jo owes $13.00",
   "Sam paid $23.00, owes $5.00"), with the rounding cent noted. Save stays disabled until every item
   has an amount and at least one person.
4. **Payment editor.** From (you by default), To, amount, date, note.
5. **Entry detail.** The items, then paid and owed per person, "Added by Sam · Edited by Alex", Edit and
   Delete (with a confirmation). Guests see Delete only on entries they added, and no Edit.
6. **Conflict popup and resolver.** The popup appears once per new conflict when the group is opened:
   "Dinner was changed by Alex and Sam at the same time", **Resolve now** or **Later**. The resolver
   shows Alex's version and Sam's side by side (stacked on phones, with a toggle), changed fields
   highlighted, a choice per field, "Use all of Alex's" / "Use all of Sam's", and the resulting split
   before saving.
7. **Join** (`/join/:token`). The group name, "Alex invited you", "Which one are you?" with the
   unclaimed non-members and "I'm not on this list", then **Create an account** or **Continue as
   guest**. Offline: "Joining needs a connection."
8. **Guest banner.** On every screen for guests: "You're a guest. When the group is completed, guests
   lose access. Add your email to keep it", which opens the email and code steps.
9. **Settings → Connected apps.** Your tokens (name, created, last used), **Connect an app** (name it,
   then the token is shown once with Copy and "You won't see this again"), and Revoke. Online only.
10. **Settle-up tracker** (owner). "3 of 5 settled" at the top. One row per person: name, "Owes
    $20.00" or "Is owed $40.00", the suggested payments underneath ("to Person 1, $20.00"), and a tick
    box. Ticked rows show **Paid** or **Received** and the payments the tick recorded; unticking asks
    "Delete the 2 payments this recorded?". People already at $0 show **Settled**. At the bottom:
    **Complete group**, with the confirmation from decision 11 (who still owes, which guests lose
    access).

Rejection toasts: `HS409` "Alex already resolved this"; `HS403` "You can't do that in this group";
`HS422` "That change couldn't be saved", with the reason underneath.

## Implementation Guide

Seven slices. Each is its own migration, tests and screens, and each ships on its own. All seven are in
the MVP. They are built in three passes rather than slice by slice: the database for every slice (chat 2),
then the logic, sync and API for every slice (chat 3), then the screens. `docs/architecture.md` §§11–12
lists the exact files, functions and tests for chats 2 and 3; the lists below stay as the per-slice view.

1. **Dollars and people** (1 day)
   - `src/lib/money.ts`: drop the currency argument; remove `minorUnitDigits` and `splitEvenly` and
     their tests once nothing uses them.
   - `supabase/migrations/004_people.sql`: roles, `joined_at`, `member.*` and `group.delete`, rejection
     codes in `push_changes()` (existing checks included), the dispatch split in
     `private.apply_mutation()`.
   - `member.*` and `group.*` intents in `planChange()` (`src/lib/changes.ts`); the People tab; Leave and Delete group.
   - Tests: `supabase/tests/people.test.sql`, `tests/lib/sync/local.test.ts` additions.
2. **Bills with items, and balances** (2½ days)
   - `supabase/migrations/005_ledger.sql`: both ledger tables (including `recorded_via`),
     `private.compute_shares()`, `entry.*`, pull additions.
   - `src/lib/ledger.ts`: `computeShares()`, `validateEntry()`, `summarizeGroup()` (the module map is `docs/architecture.md` §9).
   - Entry intents in `planChange()`; read hooks in `src/lib/entries.ts`; Dexie version 2.
   - The Entries tab, the expense editor (one item and several), entry detail, balances on the Groups
     list.
   - Tests: `tests/lib/ledger.test.ts`, `supabase/tests/ledger.test.sql`.
3. **Payments and suggested payments** (1 day): suggested payments from `summarizeGroup()` in `src/lib/ledger.ts`, the
   payment editor, the Balances tab.
4. **Edit conflicts** (1½ days)
   - `supabase/migrations/006_conflicts.sql`: `entry_conflicts`, `ledger_entry_versions`, the conflict
     branch in `entry.update` and `entry.delete`, `conflict.resolve`.
   - `mergePull` skip rule; the popup, badge and resolver.
   - Tests: `supabase/tests/conflicts.test.sql`, `tests/lib/sync/merge.test.ts` additions.
5. **Invites, guests and joining** (2 days)
   - `supabase/config.toml`: anonymous sign-ins and manual linking.
   - `supabase/migrations/007_invites.sql`: `group_invites`, `invite.*`, `preview_invite()`,
     `join_group()`, `upgrade_guest()`, the guest checks.
   - invite intents in `planChange()`, the online functions in `supabase-transport.ts`, guest sign-in and upgrade in `src/lib/auth.tsx`; the invite controls on
     People; the Join route and paste box; the guest banner.
   - Tests: `supabase/tests/invites.test.sql`, `supabase/tests/guests.test.sql`.
6. **Settle-up tracker and completing** (1 day)
   - `supabase/migrations/008_complete.sql`: `completed_at`, `group.complete` (with the
     guest unlinking and deleting), `group.reopen`, the completed-group checks.
   - the tick and untick intents in `planChange()`; the tracker screen; the Completed section and read-only
     group.
   - Tests: `supabase/tests/complete.test.sql`, `tests/lib/ledger.test.ts` additions.
7. **API v1 for Pholio** (1½ days)
   - `supabase/migrations/009_api.sql`: `api_tokens`, the `api` schema and `handshake_api` role, token
     functions, `api.v1_*` functions.
   - `api/v1/[...path].ts`, `src/server/api-v1/*`, `vercel.json` and service-worker changes, against the
     contract in `docs/api-v1.md` and `docs/api-v1.openapi.yaml`.
   - Settings → Connected apps.
   - Tests: `supabase/tests/api.test.sql`, `tests/api/v1.handler.test.ts` (handler against a fake store),
     `tests/api/v1.contract.test.ts` (responses against the OpenAPI document), `tests/api/postgres-store.test.ts`
     (opt-in, against the local database).

Every migration follows the existing rules: safe to re-run, new tables stamped by
`private.next_group_version()`, explicit grants.

## Testing Checklist

Unit (`bun test`). Amounts in cents; Person 1 pays unless stated.

- [ ] **Scenario A:** 5000 split by Persons 1–5 → owed 1000 each; balances P1 +4000, P2–P5 −1000.
- [ ] $10 by Alex, Jo, Sam, Sam paid → Alex 333, Jo 333, Sam 334; balances Sam +666, Alex −333,
      Jo −333.
- [ ] $20 by Alex, Jo, Sam, Sam paid → Alex 667, Jo 667, Sam 666; balances Sam +1334, Alex −667,
      Jo −667.
- [ ] **Scenario B:** items 500 and 1000 split by P1–P3, item 800 by P3 → owed 500, 500, 1300 (not 501
      or 499: no rounding happens); balances P1 +1800, P2 −500, P3 −1300.
- [ ] **Scenario C:** items 500 and 1000 split by P1–P3, item 800 by P2 and P3 → owed 500, 900, 900;
      balances P1 +1800, P2 −900, P3 −900.
- [ ] **Several payers, even:** item 6000 paid by P1 and item 4000 paid by P2, both split by P1–P5 →
      owed 2000 each; balances P1 +4000, P2 +2000, P3–P5 −2000; suggested payments P3→P1 2000,
      P4→P1 2000, P5→P2 2000.
- [ ] **Several payers, with a cent:** item 1000 paid by P1 split by P1–P3, item 2000 paid by P2 split
      by P1–P5 → owed P1 733, P2 734 (biggest payer covers the cent), P3 733, P4 400, P5 400; balances
      P1 +267, P2 +1266, P3 −733, P4 −400, P5 −400; suggested payments P3→P2 733, P4→P2 400,
      P5→P1 267, P5→P2 133.
- [ ] **Payer not sharing:** Sam pays 2000 split by Alex, Jo, Kim → Alex 666, Jo 667, Kim 667, Sam 0.
      Sam pays 1000 split by the same → 333 each, Sam owes 1.
- [ ] Two items of 1000, each split by the same 3, Sam paid both → others 667 each, Sam 666.
- [ ] Every `computeShares` result: Σ paid = Σ owed = total, owed ≥ 0, and the same answer whatever
      order the shares are read in.
- [ ] Balances for the Dinner and Payment table: Alex +3000, Sam 0, Jo −3000; they add up to 0.
- [ ] Suggested payments (`summarizeGroup`): Alex +60, Sam −10, Jo −50 gives Jo→Alex 50 and Sam→Alex 10; for random
      balances, never more than n − 1 payments, and applying them leaves everyone at 0.
- [ ] **Settle-up tracker,** with the "several payers, with a cent" balances: ticking P5 records
      P5→P1 267 and P5→P2 133, both with `recordedVia` `settle_up`; P5 shows Paid and P1 Received; the
      remaining suggestions are P3→P2 733 and P4→P2 400. Unticking P5 deletes both payments and
      restores the balances. A new 1000 expense paid by P1 and split by P1 and P5 afterwards unticks P5.
- [ ] `parseAmount`: "12" → 1200, "12.5" → 1250, "1,234.50" → 123450, "1.234" → null.
      `formatAmount`: 123450 → "$1,234.50", −333 → "−$3.33".
- [ ] `validateEntry` rejects everything in "Entry checks on the server".
- [ ] `mergePull`: an entry's shares are replaced, not merged; an unsent stale update by someone else is
      not replayed; a dropped group takes its entries, conflicts, invites and tokens with it.
- [ ] API handler: a missing or revoked token gives 401; a group the person isn't in gives 404;
      `GET /groups/{id}` for Sam after the $10 dinner gives paid 1000, owed 334, balance 666 and the two
      `settleUp` rows of 333.
- [ ] API contract: every handler response validates against `docs/api-v1.openapi.yaml` with no
      undocumented fields; in every group, Σ `netCents` of entries without `deletedAt` = `balanceCents`.

Database (`bun run test:db`):

- [ ] `private.compute_shares()` gives the same numbers as every unit case above.
- [ ] Sums that don't match, shares that differ from the items, a member from another group, and a
      malformed payment each give `HS422`; a non-member gives `HS403`.
- [ ] A stale update by someone else leaves the entry unchanged, creates one open conflict holding the
      base and proposed versions, and pulls to every member; your own stale update is applied.
- [ ] `conflict.resolve` with `kept_current`, `took_proposed` and `merged` each leave the expected entry
      and shares and close the conflict; a second resolve gives `HS409`; a guest resolving gives `HS403`.
- [ ] A stale delete against a newer edit creates a conflict with `proposed` NULL.
- [ ] Roles: the owner can add and remove non-members, remove members and guests, make invites and
      rename the group; a member gets `HS403` for each of those and for deleting the group; the owner
      leaving passes ownership to the member who joined first; the last full member leaving deletes the
      group, even with guests left.
- [ ] Guests: can create entries and delete their own; can't update entries, delete others' entries,
      create groups or create API tokens.
- [ ] Invites: the token is stored only as a hash; preview works with the token; expired (day 15) and
      revoked links fail; joining takes over the non-member; a taken non-member can't be claimed again;
      joining twice does nothing; an anonymous caller joins as `guest`; `upgrade_guest()` keeps the same
      member row and makes it `member`.
- [ ] API: a token is stored only as a hash; `api.v1_*` with a revoked or unknown token's hash gives
      `HS401`, and the 61st call in a minute `HS429`; `api.v1_*` returns only the token owner's groups and
      shares; the entries feed cursor pages, picks up a newly joined group and reports a left one;
      `handshake_api` can't select any table or run any function outside `api`.
- [ ] Completing: the owner can complete and reopen, a member gets `HS403`. Completing
      turns a guest's row into a non-member with the same name and history; deletes their anonymous
      user when they're in no other group, and keeps it when they are; leaves a guest who added an email
      untouched; and the removed guest can no longer pull the group. Entries, edits and invites in a
      completed group give `HS403`; after reopening they work again.
- [ ] Deleted entries are pulled with `deleted_at` set.

By hand, at 375px and 1440px:

- [ ] Add an itemised bill offline: balances change at once; reconnect, and a second browser shows it.
- [ ] Two browsers offline edit the same expense, then reconnect: both see the conflict popup; resolve
      in one; the other shows the result and no popup.
- [ ] Create an invite for a non-member, open it signed out in another browser, continue as guest, see
      the history as that person, add an entry, then add an email and confirm the role is now member.
- [ ] With a guest signed in on another browser, tick everyone off in the tracker, then complete the
      group: the confirmation names the guest; on the guest's next sync the group disappears; the
      owner sees it under Completed, read-only, with the guest's name still on their entries.
- [ ] Create a token in Connected apps, call `GET /api/v1/groups` with it, revoke it, and get 401.

`bun run typecheck`, `bun test`, `bun run test:db` and `bun run build` all exit 0 for each slice.

## Decisions for You

None open. Answered by the owner on 2026-11-03:

| #   | Question                                                 | Answer                                                                                                                                                          |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who covers the rounding cent?                            | The payer: shares round normally and the payer's own share takes the difference (decision 4). With several payers, the one who paid the most (assumed default). |
| 2   | Can a guest remove any entry, or only ones they added?   | Only ones they added                                                                                                                                            |
| 3   | Who can complete a group?                                | The owner only: there is no admin role (decision 8)                                                                                                             |
| 4   | Can a group be completed while someone still owes money? | Yes, after a confirmation naming them                                                                                                                           |
| 5   | Which slices are in the MVP?                             | All seven                                                                                                                                                       |

## Out of Scope

These belong to later specs:

- Trip planning: itinerary, polls, shared checklists, and a trip budget (the "trip allowance" from the
  old Pholio draft).
- Pholio's side of the connection: its import screen, where it stores the token, and how it shows
  Handshake data.
- OAuth for the API, write endpoints, webhooks, and items or other people's shares in API responses.
- Weighted or percentage splits, other currencies and exchange rates.
- Moving a guest's data into an account that already exists (the email is already registered).
- Completing or settling a single bill.
- Activity feed and comments.
- Receipt photos, categories, recurring expenses and refunds.
- Notifications.
- Export.
- Universal links and App Links for the native apps.

## Risks

- **Deleting guest data is permanent.** When the group is completed, a guest who never added an email
  loses their login and their view of the group, and reopening doesn't bring it back. Mitigations: only
  the login goes (the group's history and balances stay); the guest banner says so from the start; the
  completion dialog names the guests; the owner can re-invite the name.
- **Ticks that don't match what happened.** A tick records the suggested payments, which may not be
  who actually paid whom. Balances still end at $0 either way, and the owner can untick and record the
  real payment instead.
- **Guests lose access with their device.** An anonymous session lives on one device; clearing storage
  or losing the phone ends it. The guest banner keeps asking them to add an email.
- **Anonymous sign-in abuse.** Anyone can create anonymous users. They can do nothing without an invite
  token, sign-ins are rate limited per IP, and production adds Turnstile.
- **Conflicts pile up or confuse.** Most groups will never see one. The badge and popup keep them
  visible, balances keep using the current version, and the resolver shows the resulting split before
  saving. Two resolvers at once: the first wins and the second sees the result.
- **Leaked API tokens.** A token reads its owner's whole history across groups. Mitigations: read-only,
  shown once, stored hashed, never in URLs, `last_used_at` shown, revocable at once, rate limited.
  OAuth later removes copy-pasting.
- **The API drifting from the app.** Both use `src/lib/ledger.ts` and the stored shares, and the API test
  pins the same numbers as the unit tests.
- **Rounding in two places.** TypeScript and SQL must agree; the database tests run every pinned case
  through `private.compute_shares()`.
- **Browsers can wipe storage.** Safari can clear a website's storage after about 7 days without a
  visit, along with any unsent changes. Ask for persistent storage (`navigator.storage.persist()`),
  keep the waiting count visible, and recommend the native app or a home-screen install for trips.
- **Long histories.** A group's first pull sends every entry. That is fine for friend groups (hundreds
  of entries); add paging if a group passes a few thousand.
- **One owner per group.** With no admin role, only the owner can add people, invite and complete. If
  the owner is away, those wait; a "Make owner" handover can be added later.
- **Leaked invite links.** Anyone holding a live link can join, as a guest too. Links expire, can be
  revoked, and the owner can remove people.
- **Device clocks.** `entry_date` is picked by the person. Ordering of edits uses server time and
  versions, never the device clock.
