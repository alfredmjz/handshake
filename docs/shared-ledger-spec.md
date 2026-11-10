# Shared ledger: people, bills, payments, guests, conflicts, completing a group and the Pholio API

- **Status:** Agreed for the MVP (fourth draft, 2026-11-04: handshake payments, debts between pairs, the
  permission matrix and account deletion; system design and build handoffs in `docs/architecture.md`, the
  API contract in `docs/api-v1.md`, the group chat in `docs/chat-spec.md`)
- **Created:** 2026-11-03
- **Updated:** 2026-11-04
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
3. See who owes whom, between each pair of people.
4. Record a payback ("Sam paid Alex $30") that both of them confirm, a handshake. No money moves; Handshake only keeps the record.
5. Invite friends with a link. Each one either creates an account or continues as a guest.
6. Sort out the rare case where two people edit the same bill before syncing, together, like a merge
   conflict.
7. Do all of it with no signal, except joining a group, which needs the server.
8. Let the owner see who has settled, then mark the group completed.
9. Let Pholio read the money the person sent and received, without Handshake knowing anything about Pholio.

## How the money works

All amounts are dollars and cents, stored as whole cents. The app shows `$` and nothing else: no
currency codes, pickers or exchange rates.

**Everyone in a group sees everything:** every bill with every item and share, every debt, and every
payment once it counts. The only things that belong to two people alone are the buttons that settle a
debt between them, a payment still waiting for its handshake, and nudges (`docs/chat-spec.md`).

### Entries and shares

Everything recorded in a group is an **entry**: a bill (`kind = expense`) or a payment. An entry has one
**share** per member it involves, saying how much that member **paid** and how much they **owe** from it,
and **whom** they owe it to: `owedTo` splits what they owe by the person who paid for it.

- For every entry, Σ paid = total and Σ owed = total, and each share's `owedTo` adds up to its owed.
- A member's **balance** is Σ paid − Σ owed over the group's bills that are not deleted and its payments
  that count. Positive: others owe them. Negative: they owe. A group's balances always add up to 0.

Example with Alex, Sam and Jo:

| Entry                                   | Alex                                | Sam                          | Jo                           |
| --------------------------------------- | ----------------------------------- | ---------------------------- | ---------------------------- |
| Dinner $90.00, Alex paid, split equally | paid 90.00, owes 30.00 → **+60.00** | owes Alex 30.00 → **−30.00** | owes Alex 30.00 → **−30.00** |
| Payment: Sam paid Alex $30.00 (counts)  | owes 30.00 → **+30.00**             | paid 30.00 → **0.00**        | **−30.00**                   |

A payment is an entry where the person paying back "paid" and the person receiving "owes" them, which
moves both towards zero.

### Bills are made of items

A bill holds one or more **items**. Each item has an amount, **one payer**, and the people it is
**split among**, equally. A simple bill has one item; the editor only shows items when someone taps
**Add item**.

- Different items can have different payers: Item A paid by Person 1, Item B paid by Person 2.
- An amount one person owes in full ("Jo's drink, $7") is an item split among just that person. So there
  is no separate "exact amounts" mode. Percentages and weighted shares are left out (decision 2).

The stored shares are the result. The items are kept so the editor reopens as it was left, and so the
server can check the shares (decision 3).

### Rounding

Rounding is worked out **for each payer separately**, so every cent of a debt points at a person.

1. **Paid** is exact: each member's paid amount is the sum of the items they paid.
2. For each payer, each person's **exact share of that payer's items** is the sum of item amount ÷
   number of people splitting it, over that payer's items the person is in.
3. Each of those is **rounded once, normally, to the cent** (half a cent rounds up).
4. If the rounded parts don't add up to what that payer paid, **that payer covers the difference**: their
   own part takes the missing or extra cents.
5. If that would make the payer's own part negative (they paid for others and aren't sharing), the extra
   cents come off the other people's parts of that payer instead, one cent each, starting with the parts
   rounded up the most; ties go to whoever is listed first on the bill.
6. A person's **owed** is the sum of their parts; `owedTo` keeps them per payer.

A bill with one payer gives exactly what the earlier single rule gave. The device works in whole numbers
only: the exact shares are fractions with a common denominator, so nothing is ever a float.

| Bill                                                                                          | Result                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scenario A:** $50.00, split evenly by 5                                                     | $10.00 each                                                                                                                                 |
| $10.00 split by Alex, Jo and Sam; Sam paid                                                    | Alex $3.33, Jo $3.33. Sam's own part is $3.34: Sam covers the 1¢                                                                            |
| $20.00 split by Alex, Jo and Sam; Sam paid                                                    | Alex $6.67, Jo $6.67. Sam's own part is $6.66: the extra 1¢ comes off Sam's part                                                            |
| **Scenario B:** Item 1 $5 and Item 2 $10 split by all 3, Item 3 $8 by Person 3                | Person 1 $5, Person 2 $5, Person 3 $13 (total $23)                                                                                          |
| **Scenario C:** Items 1 and 2 as in B, Item 3 $8 split by Persons 2 and 3                     | Person 1 $5, Persons 2 and 3 $5 + $4 = $9 each (total $23)                                                                                  |
| **Several payers, with a cent:** $10 paid by P1 split by P1–P3; $20 paid by P2 split by P1–P5 | P1's item: P2 and P3 owe P1 $3.33 each, P1 covers 1¢ ($3.34). P2's item: $4.00 each. Owed: P1 $7.34, P2 $7.33, P3 $7.33, P4 $4.00, P5 $4.00 |

Rounding once per person per payer matters: two $10 items split three ways and paid by the same person
give each person exactly $6.67 (6.666… rounded once), where rounding per item would give $6.66.

In the editor and on the entry, the line reads "$3.33 each"; Sam's line in the detail says "$3.34, incl.
1¢ rounding", so nobody is surprised by the odd cent.

### Debts

A **debt** is worked out between two people only:

> what A owes B from bills − what B owes A from bills − payments A made to B that count + payments B made
> to A that count

If that is positive, A owes B; if negative, B owes A; if 0, they're square. Debts are never moved around
the group: Jo pays back whoever Jo actually owes. Example, groceries $60 paid by Person 1 and gas $40 paid
by Person 2, both split among Persons 1–5:

| Debt                          | From the bills           | Debt            |
| ----------------------------- | ------------------------ | --------------- |
| Person 2 → Person 1           | 12.00 − 8.00 (other way) | **$4.00**       |
| Persons 3, 4 and 5 → Person 1 | 12.00 each               | **$12.00** each |
| Persons 3, 4 and 5 → Person 2 | 8.00 each                | **$8.00** each  |

A person's balance is what everyone owes them minus what they owe everyone: Person 1 +40.00, Person 2
+20.00, Persons 3–5 −20.00.

### Paying back: the handshake

No money moves through Handshake. A payment records that someone paid someone back outside the app, and
it counts only when **both** of them say so.

- If X owes Y $10, X sees **Record $10.00 paid to Y** and Y sees **Record $10.00 received from X**.
  Either can start; the amount defaults to the whole debt and can be any positive amount (partial
  payments are fine).
- The other side then sees **Confirm** or **Decline** (with an optional note: "I didn't get this"). The
  person who started sees "Waiting for Y" and can **Undo** while it waits.
- While it waits, the payment is a **pending payment**: only the two of them see it, and debts don't
  change.
- Once both have confirmed, it **counts**: debts and balances move, and everyone in the group sees it.
- A declined or undone payment never counts. It stays in the two people's history, marked as such.
- **No handshake when the other side can't answer.** If the other side has no login (someone added by
  name, or an account that was deleted) or has left the group, the person with the app records it alone
  and it counts at once. Between two such people, any full member (owner or member) records it, and it
  shows "Recorded by Alex". Leaving a group undoes the leaver's pending payments there, as deleting an
  account does.
- A payment that counts can't be edited or deleted. A mistake is put right with a payment back the other
  way, which needs its own handshake.
- Pholio sees a payment when it counts (`docs/api-v1.md`).

### Settling up and completing

The owner's **Settle up** screen shows progress, not buttons for other people: "3 of 5 settled", and each
person as **Settled**, **Owes $20.00**, **Is owed $40.00** or **Waiting for confirmation**. When the trip
is done, the owner **completes the group** (decision 11).

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

### 4. Rounding: once per person and payer, the payer covers the difference

- **Chosen Solution:** the rule in "Rounding" above. Confirmed by the owner on 2026-11-03: in $10 split
  three ways, the two who pay back each pay $3.33 and the payer absorbs the cent. On 2026-11-04 it became
  per payer: with several payers, each payer absorbs the rounding on their own items (it was "the
  biggest payer"), so every cent of a debt points at the person it is owed to (decision 18). The exact
  integer algorithm is in `docs/architecture.md` §9.3.
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
  admin role** (owner, 2026-11-03). A **name-only person** is someone added by name who hasn't joined, or
  whose login is gone (a member row with no `user_id`). What each role may do is **one matrix of
  actions** (decision 20), the same in SQL and TypeScript:

| Action                                                    | Owner | Member | Guest | Allowed in a completed group |
| --------------------------------------------------------- | ----- | ------ | ----- | ---------------------------- |
| `group.rename`                                            | ✓     |        |       |                              |
| `group.delete`                                            | ✓     |        |       | ✓                            |
| `group.complete`                                          | ✓     |        |       |                              |
| `group.reopen`                                            | ✓     |        |       | ✓ (only then)                |
| `member.add` (by name)                                    | ✓     | ✓      |       |                              |
| `member.rename.self`                                      | ✓     | ✓      | ✓     |                              |
| `member.rename.others`                                    | ✓     |        |       |                              |
| `member.remove.self` (leave)                              | ✓     | ✓      | ✓     | ✓                            |
| `member.remove.others`                                    | ✓     |        |       |                              |
| `entry.create` (bills)                                    | ✓     | ✓      | ✓     |                              |
| `entry.update`                                            | ✓     | ✓      |       |                              |
| `entry.delete.own`                                        | ✓     | ✓      | ✓     |                              |
| `entry.delete.others`                                     | ✓     | ✓      |       |                              |
| `conflict.resolve`                                        | ✓     | ✓      |       |                              |
| `invite.create`                                           | ✓     | ✓      |       |                              |
| `invite.revoke.own`                                       | ✓     | ✓      |       |                              |
| `invite.revoke.others`                                    | ✓     |        |       |                              |
| `payment.record.own` (you are one side)                   | ✓     | ✓      | ✓     |                              |
| `payment.record.others` (two name-only people)            | ✓     | ✓      |       |                              |
| `payment.respond` (confirm or decline, as the other side) | ✓     | ✓      | ✓     | ✓                            |
| `payment.undo` (you started it, still pending)            | ✓     | ✓      | ✓     |                              |

Chat actions (`message.*`, `nudge.send`) are in `docs/chat-spec.md`. Everyone can view everything in
the group. Two account rules sit outside the matrix: guests can't create groups or API tokens.

- When the owner leaves, ownership passes to the full member who joined first (`joined_at`, then id).
  When the last full member leaves, the group is deleted, even if guests remain.
- Removing someone keeps their history: their shares stay, their debts show with "(left)" until settled,
  and pickers stop offering them. Nothing deletes entries except deleting them.
- Deleting a group is a soft delete; it disappears for everyone on their next sync.
- **Why:** the owner decided that completing the group and removing people are their job alone. Adding
  people by name and inviting are open to members too (owner, 2026-11-04), because whoever adds "Jo" to a
  bill usually wants to send Jo the link. Bills stay open to everyone, because friend groups trust each
  other and the app works best when whoever has the receipt adds it.
- **Later:** a "Make owner" handover, so an owner who is away can pass the job on (a new mutation, no
  schema change).

### 9. Name-only people, invite links and guests

- **Chosen Solution:**
  - The owner or any member adds name-only people, so bills can include them at once.
  - An invite link is valid for **14 days**, can be used many times, and can be revoked. It can be tied
    to a name-only person ("Invite Jo"), so whoever opens it becomes Jo. The owner and members make
    invites; members revoke the ones they made, and the owner revokes any.
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

### 10. Settle up is a progress view

- **Chosen Solution:**
  - Before completing, the owner opens **Settle up**: "3 of 5 settled" at the top, then one row per
    person with their state: **Settled**, **Owes $20.00**, **Is owed $40.00**, or **Waiting for
    confirmation** when one of their payments is pending. Tapping a row shows that person's debts.
  - Nothing on this screen records payments. Each payment is settled by the two people involved, with a
    handshake (decision 17); the owner can only record payments between two name-only people.
  - Everything it shows is worked out on the device from synced rows, like every other screen.
  - At the bottom: **Complete group** (decision 11).
- **Why:** with handshakes, the owner can't pay on someone's behalf, so the tracker's job is to show who
  is done. It changed on 2026-11-04 from "ticking someone off records their payments".
- **Alternatives considered:** the owner ticking people off (bypasses the handshake); no tracker at all
  (the owner would have to read every person's debts to know when to complete).

### 11. Completing a group deletes guests' logins

- **Chosen Solution:**
  - **"Completed" applies to the whole group**, not to a single bill. A friend group or trip ends as a
    whole, and a guest belongs to a group, so deleting a guest per bill doesn't make sense.
  - The owner taps **Complete group** at the bottom of Settle up. If anyone still owes money, the
    confirmation says so ("Jo still owes Sam $20.00. Complete anyway?"). It also names the guests who will
    lose access: "Kim and Lee are guests. They will lose access to this group. Their names and history
    stay."
  - `group.complete` sets `completed_at` and `completed_by_member_id`. A completed group is read-only:
    only the actions marked in decision 8's matrix still work (reopen, delete, leave, and answering a
    pending payment's handshake); everything else gives `HS403`, the chat included. It moves to a
    **Completed** section on the Groups list.
  - In the same transaction, every guest in the group who hasn't added an email has their data deleted:
    - Their member row becomes a name-only person again (`user_id` NULL, role `member`), so every
      entry and balance still adds up and shows their name.
    - If they are no longer in any group, their anonymous `auth.users` row is deleted, which also
      removes their profile and `sync_mutations` rows. A guest still in another group keeps their login
      there.
    - Entries record who added and edited them by **member id**, not user id, so "Added by Kim"
      survives.
  - Guests who added an email before completion are members by then, so nothing happens to them.
  - **Reopen group** (owner) makes it editable again. Deleted guest logins don't come back; the
    owner can invite those names again, and whoever joins takes over the name-only person and their history.
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
  `HS409` also covers answering a payment that is no longer pending (someone confirmed, declined or
  undid it first).

### 17. Payments count only after a handshake

- **Chosen Solution** (owner, 2026-11-04; the app is named for it):
  - A payment is recorded by one side and confirmed by the other. Its state is `pending` until then,
    `confirmed` once both agree, or `declined` / `undone` if it never happened.
  - Either side can start (`payment.record`): the payer ("I paid Y") or the receiver ("X paid me"), for
    any positive amount, defaulting to the whole debt. Starting counts as that side's confirmation.
  - The other side answers with `payment.confirm` or `payment.decline` (with an optional note up to 200
    characters). The starter can `payment.undo` while it is pending. Whichever answer reaches the server
    first wins; a later one gets `HS409`.
  - Only `confirmed` payments count in debts, balances and the API. A pending payment is shown only to its
    two people; the row syncs to the whole group, and screens show it to the two (decision 18 makes
    every confirmed payment visible to all).
  - **No handshake when the other side can't answer.** When the other side has no active member row with a
    login (name-only, account deleted, or left the group), the payment is `confirmed` the moment it is
    recorded. Between two such people any full member records it. Leaving undoes the leaver's pending
    payments in that group (2026-11-05, so none is left waiting for someone who can't answer).
  - A confirmed payment can't be edited or deleted; a mistake is corrected with a payment the other way.
- **Why:** "dual side validation": a payback is real when both people agree it happened, and that is
  the record Pholio takes.
- **Alternatives considered:** recording alone (the earlier draft; one person's word moves the other's
  balance); only the receiver confirming (the payer has no say over what was recorded in their name).

### 18. Debts are between pairs, and everyone sees them

- **Chosen Solution** (owner, 2026-11-04):
  - A debt is worked out between two people from their bills and their confirmed payments ("Debts"
    above). It is never simplified across the group: nobody is told to pay someone they don't owe.
  - Everyone in the group sees every bill, every debt and every confirmed payment. What's personal is
    only the buttons: X sees **Record $10.00 paid to Y**, Y sees **Record $10.00 received from X**, and
    each sees the other's pending payment to answer.
  - Shares store `owedTo` (what each person owes each payer), so debts are sums over stored rows on every
    device and in the API, never a re-run of the rounding.
- **Why:** with handshakes, each payment is between two real people. Group-simplified suggestions
  ("Jo pays Alex", when Jo's debt is to Sam) would make people hand-shake about debts they don't
  recognise.
- **Trade-off:** more payments than the fewest possible. A group of five with two payers settles in up to
  seven payments instead of four.
- **Alternatives considered:** the greedy "fewest payments" suggestions of the earlier draft.

### 19. Deleting an account

- **Chosen Solution** (owner, 2026-11-04):
  - **Settings → Delete account**, then one confirmation dialog. If they still owe or are owed money,
    the dialog names it ("You still owe Sam $10.00 in Banff trip"), and deleting is still allowed.
  - `delete_account()` (online only) does it all in one transaction:
    - every member row of theirs becomes a name-only person with the same name, so every bill, payment
      and message still shows who it was;
    - groups they own pass to the full member who joined first; a group with no full member left is
      deleted;
    - their pending payments are `undone`;
    - their API tokens are deleted, so Pholio's connection stops;
    - their `auth.users` row is deleted, which removes their profile and `sync_mutations` rows.
  - The device then clears its local data and signs out. Guests can delete too (the same dialog).
  - Their debts stay with their name. Because they have no login any more, anyone they owed (or who owed
    them) can record payments with them alone (decision 17).
- **Why:** store rules require deleting an account inside the app, and the group's shared record must
  still add up.
- **Alternatives considered:** "Deleted user" instead of their name (the history becomes unreadable);
  requiring a fresh email code (owner chose the dialog alone).

### 20. One permission matrix, held in step by a shared case table

- **Chosen Solution:**
  - Decision 8's table is the only definition of who may do what, as actions × roles plus "allowed in a
    completed group". SQL asks `private.may(action, role)` and `private.allowed_when_completed(action)`
    through one `private.require(user, group, action)`; TypeScript asks `may()` in
    `src/lib/permissions.ts`, which both `planChange` and screens (to show or hide buttons) use.
  - `tests/fixtures/permission-cases.ts` transcribes the table by hand. TypeScript tests run it against
    `may()`; a generator turns it into pgTAP against `private.may()`, as with the ledger cases.
  - Only allowed / not allowed and the codes are pinned; each side words its own refusal reasons.
- **Why:** the rule was written 15 times in SQL and would have been written again on the device, with
  nothing to catch them drifting apart.

## Data Model

### Server

`groups` gains `completed_at TIMESTAMPTZ NULL` and `completed_by_member_id UUID NULL → group_members`, and
(010) `note TEXT NULL`: the optional second line on the group's cover ("Tokyo and Kyoto, April"), written by
the owner, trimmed, 1–120 characters; blank is stored as NULL.

`group_members` changes:

- `role` allows `owner`, `member`, `guest` (the check constraint is dropped and re-added).
- Gains `joined_at TIMESTAMPTZ`, set whenever `user_id` is set (backfilled from `created_at`).

`ledger_entries`

| Column                  | Type                 | Notes                                                                                                               |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                    | UUID PK              | Made on the device                                                                                                  |
| `group_id`              | UUID → groups        |                                                                                                                     |
| `kind`                  | TEXT                 | `expense` or `payment`                                                                                              |
| `description`           | TEXT                 | 1–120 characters; payments default to "Payment"                                                                     |
| `amount_cents`          | BIGINT               | > 0 and ≤ 10¹²; the bill total                                                                                      |
| `items`                 | JSONB NULL           | Expenses only; see below                                                                                            |
| `entry_date`            | DATE                 | The day it happened, chosen by the person                                                                           |
| `notes`                 | TEXT NULL            | ≤ 1000 characters                                                                                                   |
| `category`              | TEXT NULL            | Bills only (010): `food`, `drinks`, `stay`, `travel`, `groceries`, `fun`, or NULL for none; always NULL on payments |
| `payment_status`        | TEXT NULL            | Payments only: `pending`, `confirmed`, `declined`, `undone`                                                         |
| `payer_confirmed_at`    | TIMESTAMPTZ NULL     | Payments: when the payer's side agreed                                                                              |
| `receiver_confirmed_at` | TIMESTAMPTZ NULL     | Payments: when the receiver's side agreed                                                                           |
| `confirmed_at`          | TIMESTAMPTZ NULL     | Payments: when it started to count                                                                                  |
| `closed_at`             | TIMESTAMPTZ NULL     | Payments: when it was declined or undone                                                                            |
| `close_note`            | TEXT NULL            | The decline note, ≤ 200 characters                                                                                  |
| `created_by_member_id`  | UUID → group_members | Member ids, so history survives a guest being deleted                                                               |
| `updated_by_member_id`  | UUID → group_members | Used by the conflict rule (decision 6)                                                                              |
| `created_at`            | TIMESTAMPTZ          | Server time                                                                                                         |
| `updated_at`            | TIMESTAMPTZ          | Server time                                                                                                         |
| `deleted_at`            | TIMESTAMPTZ NULL     |                                                                                                                     |
| `row_version`           | BIGINT               | From `private.next_group_version()`                                                                                 |

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

`ledger_share_parts` (primary key `entry_id, member_id, payer_member_id`): what each person owes each
payer from the entry, the `owedTo` of decision 18. For each share, Σ parts = `owed_cents`; a payer's own
part is included. A payment has one part: the receiver "owes" the payer the amount.

| Column            | Type                                    | Notes                    |
| ----------------- | --------------------------------------- | ------------------------ |
| `entry_id`        | UUID → ledger_entries ON DELETE CASCADE |                          |
| `group_id`        | UUID → groups                           | Copied for RLS and pulls |
| `member_id`       | UUID → group_members                    | Who owes                 |
| `payer_member_id` | UUID → group_members                    | Whom they owe            |
| `owed_cents`      | BIGINT ≥ 0                              |                          |

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
| `claim_member_id` | UUID NULL → group_members | The name-only person it is for     |
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

- `entries`: `id, groupId, [groupId+entryDate]`; each record holds its `items`, its `shares` (each with
  `owedTo`, payer id → cents) and, for payments, its handshake fields.
- `conflicts`: `id, entryId, groupId`.
- `invites`: `id, groupId`.
- `inviteTokens`: `inviteId`; local only, never synced.
- `keepOnlyGroups` also drops the entries, conflicts, invites and tokens of groups that are gone.
- Version 3 (010) adds no index: it fills `note` (groups) and `category` (entries) with null and clears
  the cursors, so the next pull brings both.

## Sync Changes

### New mutations

"Who" is the action in decision 8's matrix that the server checks.

| Type               | Fields                                                                                                        | Action checked                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `member.add`       | `memberId, groupId, displayName`                                                                              | `member.add`                                      |
| `member.rename`    | `memberId, groupId, displayName`                                                                              | `member.rename.self` or `.others`                 |
| `member.remove`    | `memberId, groupId`                                                                                           | `member.remove.self` (leave) or `.others`         |
| `group.create`     | `groupId, memberId, name, displayName`; `note` optional (010)                                                 | not anonymous (an account rule)                   |
| `group.rename`     | `groupId, name` (exists today)                                                                                | `group.rename`                                    |
| `group.describe`   | `groupId, note` (010; null or blank clears it)                                                                | `group.rename`                                    |
| `group.delete`     | `groupId`                                                                                                     | `group.delete`                                    |
| `group.complete`   | `groupId`                                                                                                     | `group.complete`                                  |
| `group.reopen`     | `groupId`                                                                                                     | `group.reopen`                                    |
| `entry.create`     | `entryId, groupId, description, amountCents, entryDate, notes, items, shares[]`; `category` optional (bills)  | `entry.create`                                    |
| `entry.update`     | Same as `entry.create`, plus `baseVersion` (bills only)                                                       | `entry.update`                                    |
| `entry.delete`     | `entryId, groupId, baseVersion` (bills only)                                                                  | `entry.delete.own` or `.others`                   |
| `conflict.resolve` | `conflictId, entryId, groupId, resolution, entry` (the final version with its `category`, or `deleted: true`) | `conflict.resolve`                                |
| `invite.create`    | `inviteId, groupId, token, claimMemberId, expiresAt`                                                          | `invite.create`                                   |
| `invite.revoke`    | `inviteId, groupId`                                                                                           | `invite.revoke.own` or `.others`                  |
| `payment.record`   | `entryId, groupId, fromMemberId, toMemberId, amountCents, entryDate, notes`                                   | `payment.record.own` or `.others` (decision 17)   |
| `payment.confirm`  | `entryId, groupId`                                                                                            | `payment.respond`, as the side that hasn't agreed |
| `payment.decline`  | `entryId, groupId, note`                                                                                      | `payment.respond`, as the side that hasn't agreed |
| `payment.undo`     | `entryId, groupId`                                                                                            | `payment.undo`, as the side that started it       |

Each share is `{ memberId, paidCents, owedCents, owedTo }`, where `owedTo` maps payer member ids to
cents. A payment's shares are worked out from `fromMemberId`, `toMemberId` and the amount, so the
mutation doesn't carry them. Payments have no `recordedVia` (the settle-up tracker no longer records
payments) and are never in conflict: they are only recorded, answered or undone. `group.create` stops
sending `baseCurrency`; the server keeps the column default. There is no `member.setRole`.

A bill's `category` (010) is missing or null for none, else one of the six names; anything else is `HS422`,
and so is a `payment.record` that carries one. It is part of the bill like `notes`: version snapshots and
conflicts keep it, so the resolver can compare it (a snapshot from before 010 reads as none). A group's
cover shows its most common category among live bills; a tie goes to the most recent of the tied bills,
and a group with no categorised bills shows a neutral "new" hand (worked out on the device,
`groupCategory()` in `src/lib/categories.ts`).

`private.apply_mutation()` dispatches to one private function per type instead of growing one `CASE`.

### Entry checks on the server

Rejected with `HS403`: the caller is not an active member, the group is deleted, or the matrix in
decision 8 doesn't allow the action for the caller's role (in a completed group, unless the action is
allowed there).

Rejected with `HS422`:

- A share's member, an item's payer or someone in `splitAmong` is not in this group, or a member appears
  twice.
- An amount is zero, negative or not a whole number.
- A bill with no items, an item with nobody to split among, or items that don't add up to the total.
- Shares (including `owedTo`) that differ from `private.compute_shares(items)`.
- A payment whose two sides are the same member, or not both in this group.
- `payment.record.own` where the caller is neither side; `payment.record.others` where either side has a
  login.
- `entry.update` or `entry.delete` on a payment; an update that changes `group_id` or `kind`.

A stale edit by someone else becomes a conflict (decision 6), not a rejection. Rejected with `HS409`:
resolving a conflict that is already resolved, and confirming, declining or undoing a payment that is no
longer pending. Confirming or declining your own side, or undoing a payment you didn't start, is `HS403`.
The device runs the same checks before saving, so these rejections only happen when devices disagree.

Updating or deleting an entry the server never received (its create was rejected) is accepted and does
nothing, so one bad entry doesn't produce two error toasts. The same goes for answering or undoing a
payment the server never received.

### Pull additions

Each group in `changes` gains `entries` (each with its `items`, its `shares` with `owed_to`, and a
payment's handshake fields), `conflicts` and `invites` (without `token_hash`). Groups gain `completed_at`
and `completed_by_member_id` and (010) `note`; entries gain `category`; members gain `joined_at`. Deleted entries come through with `deleted_at`
set. Pending payments sync to the whole group like any row; screens show them only to their two people.
A guest removed by completion is no longer a member, so their next pull drops the group from their
device.

### Online-only functions

All are `SECURITY DEFINER` and for signed-in users only (anonymous users included unless noted). Exact
return shapes are in `docs/architecture.md` §11.2.

- `preview_invite(p_token TEXT)` returns the group name, who made the link, the unclaimed name-only people
  (id and name), and whether the caller is already in the group. Expired, revoked or unknown tokens raise
  `HS404`. **Also callable signed out** (`anon`), so the join screen can show the group first; the token
  is 256 random bits, so it can't be guessed.
- `join_group(p_token TEXT, p_claim_member_id UUID DEFAULT NULL, p_display_name TEXT DEFAULT NULL)`
  returns the group id. It does nothing if the caller is already in the group. The role is `guest` when
  the caller is anonymous, else `member`. If the link is tied to a name-only person, or one is chosen, the
  caller takes it over (it must be unclaimed and not removed); otherwise a member is added under
  `p_display_name`, or the caller's profile name when that is empty (guests have no useful profile name).
  Someone who left and comes back gets their old member row back, with its history. It stamps the group's
  next version, so other devices pull the change.
- `upgrade_guest()` (the caller must no longer be anonymous) turns the caller's `guest` rows into
  `member`, copies their new email into their profile, and stamps each group's next version.
- `create_api_token(p_name TEXT)` returns `{ id, token, name, createdAt }`, the token only this once.
  `list_api_tokens()` and `revoke_api_token(p_id UUID)`. Not for anonymous users.
- `delete_account()` (guests included) does everything in decision 19 in one transaction, stamping each
  affected group's next version so the others pull the change, and returns nothing. The device then
  clears local data and signs out.

## Handshake API v1 (for Pholio)

Read-only, versioned HTTP. Base URL: `https://<handshake domain>/api/v1`. JSON, camelCase, amounts in
whole cents (`…Cents`), dates `YYYY-MM-DD`, timestamps ISO 8601 UTC. Every response is about the person
who owns the token.

**Pholio takes only money that moved** (owner, 2026-11-04): payments that count, money the person sent
and money they received. Bills are the friends' shared record and stay in Handshake.

### Endpoints

| Method and path                  | Returns                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `GET /me`                        | `{ userId, displayName }`                                                      |
| `GET /groups`                    | `{ groups }`: `id, name, role, memberId, balanceCents, completedAt, updatedAt` |
| `GET /groups/{groupId}`          | One group as above, plus `debts`: the person's own debts, each way             |
| `GET /groups/{groupId}/payments` | That group's payments that involve the person and count, as a change feed      |
| `GET /payments`                  | The same across all their groups; the call Pholio uses to stay in sync         |

A payment: `{ id, groupId, groupName, direction, counterpartyMemberId, counterpartyName, amountCents,
entryDate, notes, confirmedAt }`, where `direction` is `sent` (the person paid it) or `received`.
Pending, declined and undone payments are never returned. A payment that counts never changes, so the
feed only adds rows.

Payment lists are a **change feed**: they take `cursor` and `limit` (default 100, at most 500) and return
`{ payments, nextCursor, hasMore, removedGroupIds }`. The cursor is opaque and holds, per group, the last
version Pholio has seen, like the device's pull cursors (ADR-004 in `docs/architecture.md`).
`removedGroupIds` lists groups the person has left or that were deleted.

The full contract, with every field, error and header, is `docs/api-v1.md` and
`docs/api-v1.openapi.yaml`; this section only summarises it.

Example: `GET /groups/{id}` for Sam after the $10.00 dinner Sam paid, split by Alex, Jo and Sam, and a
$3.33 payment from Alex that both confirmed:

```json
{
	"id": "…",
	"name": "Banff trip",
	"role": "member",
	"memberId": "…",
	"balanceCents": 333,
	"completedAt": null,
	"updatedAt": "2026-11-04T18:20:00.000Z",
	"debts": [{ "memberId": "…", "name": "Jo", "direction": "owes_you", "amountCents": 333 }]
}
```

### Errors and limits

- Errors are `{ "error": { "code": "…", "message": "…" } }`: `401 invalid_token` (missing, unknown or
  revoked), `404 not_found` (including groups the person isn't in), `400 bad_request`,
  `405 method_not_allowed`, `429 rate_limited` (60 requests a minute per token, with `Retry-After`),
  `500 server_error`.
- Tokens only in the `Authorization` header, never in URLs.
- Responses are `Cache-Control: no-store`. CORS is open (`*`) because the API uses bearer tokens, not
  cookies; Pholio should still keep the token on its server.

### Versioning

- Within v1, changes are additive only: new endpoints, new optional parameters, new fields. Pholio must
  ignore fields it doesn't know.
- Anything breaking goes in `/api/v2`, and v1 keeps working for at least 6 months after v2 ships.
- `docs/api-v1.md` is the contract Pholio's side is built against.

### How it is built

- `api/v1/[...path].ts`: one Vercel function that checks the token's format, hashes it, routes, and makes
  one call to an `api.v1_*(token_hash, …)` SQL function, which authenticates, rate-limits, updates
  `last_used_at` and returns the person's rows. Debts come from `src/lib/ledger.ts`.
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
   buttons, and offers Reopen group to the owner. Two main buttons: **Add expense** and **Settle up**
   (owner, 2026-11-09, following the design canvas); payments start from a debt's button on Balances or
   from Settle up. A segmented control: **Entries | Balances | People**, opening on Entries.
   - **Entries:** newest first, grouped by day. A row shows the description, "Alex paid $90.00" (or
     "Alex and Sam paid $100.00"), and what it means for you: "You owe $30.00", "You lent $60.00" or
     "Not involved". Payments read "Sam paid Alex $30.00". Unsynced entries say "Not synced yet";
     conflicted ones show **Needs resolving**.
   - **Balances:** your debts first, each with its button: "You owe Sam $10.00 · **Record payment**",
     "Jo owes you $20.00 · **Record received**". Your pending payments sit with them: "Waiting for Sam ·
     **Undo**", or "Jo says they paid you $10.00 · **Confirm** · **Decline**". Then everyone else's debts
     ("Kim owes Alex $5.00"), read-only, and debts with name-only people, where any full member can record
     a payment. Someone who left shows "(left)". Payments show in Entries once they count.
   - **People:** members (the owner labelled Owner), then guests, then "Not joined yet" name-only people.
     The owner sees Add person, Remove, and invite links: create, copy, share (Web Share API, or the
     native share sheet), revoke, and the expiry date.
3. **Expense editor.** Full screen on phones, a dialog on desktop. Description, date (today), notes.
   One item to start: amount, **Paid by** (you first, then alphabetical), and **Split between** (a
   checkbox per person, everyone ticked). **Add item** turns it into a list of items, each with its own
   amount, payer and people, and a running total. Below: each person's result ("Jo owes $13.00",
   "Sam paid $23.00, owes $5.00"), with the rounding cent noted. Save stays disabled until every item
   has an amount and at least one person.
4. **Payment editor.** Opened from a debt's button: who and which way are already set ("You paid Sam" or
   "Jo paid you"), the amount defaults to the whole debt, plus date and note. Saving shows "Waiting for
   Sam to confirm", or counts at once when the other side is a name-only person.
5. **Entry detail.** The items, then paid and owed per person, "Added by Sam · Edited by Alex", Edit and
   Delete (with a confirmation). Guests see Delete only on entries they added, and no Edit.
6. **Conflict popup and resolver.** The popup appears once per new conflict when the group is opened:
   "Dinner was changed by Alex and Sam at the same time", **Resolve now** or **Later**. The resolver
   shows Alex's version and Sam's side by side (stacked on phones, with a toggle), changed fields
   highlighted, a choice per field, "Use all of Alex's" / "Use all of Sam's", and the resulting split
   before saving.
7. **Join** (`/join/:token`). The group name, "Alex invited you", "Which one are you?" with the
   unclaimed name-only people and "I'm not on this list", then **Create an account** or **Continue as
   guest**. Offline: "Joining needs a connection."
8. **Guest banner.** On every screen for guests: "You're a guest. When the group is completed, guests
   lose access. Add your email to keep it", which opens the email and code steps.
9. **Settings.** **Connected apps:** your tokens (name, created, last used), **Connect an app** (name it,
   then the token is shown once with Copy and "You won't see this again"), and Revoke. Online only.
   **Delete account:** the dialog from decision 19, naming any open debts. Online only.
10. **Settle up** (everyone; completing is the owner's). "3 of 5 settled" at the top. One row per person
    with their state (Settled, Owes $20.00, Is owed $40.00, Waiting for confirmation); tapping a row lists
    their debts. Below, a card per payment that involves you, with **Shake on it**. At the bottom, for the
    owner: **Complete group**, with the confirmation from decision 11 (who still owes, which guests lose
    access). In a completed group it still lists the remaining debts, read-only, with no buttons (owner,
    2026-11-09).

Rejection toasts: `HS409` "Alex already resolved this" (or "Sam already answered this payment"); `HS403`
"You can't do that in this group";
`HS422` "That change couldn't be saved", with the reason underneath.

## Implementation Guide

Seven slices. Each is its own migration, tests and screens, and each ships on its own. All seven are in
the MVP. They are built in three passes rather than slice by slice: the database for every slice (chat 2),
then the logic, sync and API for every slice (chat 3), then the screens. `docs/architecture.md` §§11–12
lists the exact files, functions and tests for chats 2 and 3; the lists below stay as the per-slice view.
Slice 8, the group chat and nudges, follows the MVP (`docs/chat-spec.md`).

1. **Dollars and people** (1 day)
   - `src/lib/money.ts`: drop the currency argument; remove `minorUnitDigits` and `splitEvenly` and
     their tests once nothing uses them.
   - `supabase/migrations/004_people.sql`: roles, `joined_at`, `member.*` and `group.delete`, rejection
     codes in `push_changes()` (existing checks included), the dispatch split in
     `private.apply_mutation()`.
   - `member.*` and `group.*` intents in `planChange()` (`src/lib/changes.ts`); the People tab; Leave and Delete group.
   - Tests: `supabase/tests/people.test.sql`, `tests/lib/sync/local.test.ts` additions.
2. **Bills with items, and balances** (2½ days)
   - `supabase/migrations/005_ledger.sql`: the ledger tables (with `ledger_share_parts`),
     `private.compute_shares()`, `entry.*`, pull additions.
   - `src/lib/ledger.ts`: `computeShares()`, `validateEntry()`, `summarizeGroup()` (the module map is `docs/architecture.md` §9).
   - Entry intents in `planChange()`; read hooks in `src/lib/entries.ts`; Dexie version 2.
   - The Entries tab, the expense editor (one item and several), entry detail, balances on the Groups
     list.
   - Tests: `tests/lib/ledger.test.ts`, `supabase/tests/ledger.test.sql`.
3. **Debts and handshake payments** (1½ days)
   - `005_ledger.sql`: `ledger_share_parts` and per-payer rounding in `private.compute_shares()`; payment
     columns; `payment.record`, `payment.confirm`, `payment.decline`, `payment.undo`.
   - Debts from `summarizeGroup()` in `src/lib/ledger.ts`; payment intents in `planChange()`; the Balances
     tab with each debt's button and pending payments; the payment editor.
   - Tests: `tests/lib/ledger.test.ts` (debts), `tests/lib/changes.test.ts` (handshake intents),
     `supabase/tests/payments.test.sql`.

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
6. **Settle up, completing and deleting an account** (1½ days)
   - `supabase/migrations/008_complete.sql`: `completed_at`, `group.complete` (with the guest unlinking
     and deleting), `group.reopen`, the completed-group checks, `delete_account()`.
   - The Settle up progress screen; the Completed section and read-only group; Settings → Delete account.
   - Tests: `supabase/tests/complete.test.sql`, `supabase/tests/delete-account.test.sql`,
     `tests/lib/ledger.test.ts` additions.

7. **API v1 for Pholio** (1½ days)
   - `supabase/migrations/009_api.sql`: `api_tokens`, the `api` schema and `handshake_api` role, token
     functions, `api.v1_*` functions.
   - `api/v1/[...path].ts`, `src/server/api-v1/*`, `vercel.json` and service-worker changes, against the
     contract in `docs/api-v1.md` and `docs/api-v1.openapi.yaml`.
   - Settings → Connected apps.
   - Tests: `supabase/tests/api.test.sql`, `tests/api/v1.handler.test.ts` (handler against the memory store),
     `tests/api/v1.contract.test.ts` (responses against the OpenAPI document), `tests/api/postgres-store.test.ts`
     (opt-in, against the local database).

Every migration follows the existing rules: safe to re-run, new tables stamped by
`private.next_group_version()`, explicit grants.

## Testing Checklist

Unit (`bun test`). Amounts in cents; Person 1 pays unless stated. "Parts" are `owedTo`, written
debtor→payer. The pinned cases live once in `tests/fixtures/ledger-cases.ts` and run against both the
TypeScript and the SQL rounding.

- [ ] **Scenario A:** 5000 split by Persons 1–5 → owed 1000 each; balances P1 +4000, P2–P5 −1000; debts
      P2–P5 → P1 1000 each.
- [ ] $10 by Alex, Jo, Sam, Sam paid → Alex 333, Jo 333, Sam 334; balances Sam +666, Alex −333,
      Jo −333; debts Alex→Sam 333, Jo→Sam 333.
- [ ] $20 by Alex, Jo, Sam, Sam paid → Alex 667, Jo 667, Sam 666; balances Sam +1334, Alex −667,
      Jo −667.
- [ ] **Scenario B:** items 500 and 1000 split by P1–P3, item 800 by P3 → owed 500, 500, 1300 (no
      rounding happens); balances P1 +1800, P2 −500, P3 −1300.
- [ ] **Scenario C:** items 500 and 1000 split by P1–P3, item 800 by P2 and P3 → owed 500, 900, 900;
      balances P1 +1800, P2 −900, P3 −900.
- [ ] **Several payers, even:** item 6000 paid by P1 and item 4000 paid by P2, both split by P1–P5 →
      parts: everyone →P1 1200, everyone →P2 800; owed 2000 each; balances P1 +4000, P2 +2000, P3–P5
      −2000; debts P2→P1 400, P3→P1 1200, P3→P2 800, P4→P1 1200, P4→P2 800, P5→P1 1200, P5→P2 800.
- [ ] **Several payers, with a cent:** item 1000 paid by P1 split by P1–P3, item 2000 paid by P2 split
      by P1–P5 → parts P1→P1 334 (P1 covers the cent on P1's item), P2→P1 333, P3→P1 333, everyone →P2
      400; owed P1 734, P2 733, P3 733, P4 400, P5 400; balances P1 +266, P2 +1267, P3 −733, P4 −400,
      P5 −400; debts P1→P2 67, P3→P1 333, P3→P2 400, P4→P2 400, P5→P2 400.
- [ ] **Payer not sharing:** Sam pays 2000 split by Alex, Jo, Kim → Alex 666, Jo 667, Kim 667, Sam 0.
      Sam pays 1000 split by the same → 333 each, Sam owes 1.
- [ ] Two items of 1000, each split by the same 3, Sam paid both → others 667 each, Sam 666.
- [ ] Every `computeShares` result: Σ paid = Σ owed = total, each share's parts add up to its owed,
      owed ≥ 0, and the same answer whatever order the shares are read in.
- [ ] Balances for the Dinner and Payment table: Alex +3000, Sam 0, Jo −3000; they add up to 0.
- [ ] Debts and handshakes (`summarizeGroup`, through the Dinner example): after a **pending** payment
      Sam→Alex 3000, debts are unchanged (Sam→Alex 3000, Jo→Alex 3000); once **confirmed**, Sam→Alex 0;
      a **declined** or **undone** one never counts; a confirmed payment Sam→Alex 2000 leaves Sam→Alex 1000. For random bills and payments, Σ debts each person is owed − Σ they owe = their balance.
- [ ] Settle up states: in the Dinner example after Sam's pending payment, Alex "Is owed 6000", Sam
      "Waiting for confirmation", Jo "Owes 3000"; once confirmed, Sam "Settled".
- [ ] `planChange` handshakes: the payer or the receiver can record; only the other side can confirm or
      decline (`HS403` otherwise); only the starter can undo; answering a payment that isn't pending
      plans `HS409`; with a name-only counterpart the payment plans as confirmed at once; between two
      name-only people a member can record and a guest can't.
- [ ] Permission cases (`tests/fixtures/permission-cases.ts`): every action × role matches decision 8,
      and every "allowed in a completed group" mark.
- [ ] `parseAmount`: "12" → 1200, "12.5" → 1250, "1,234.50" → 123450, "1.234" → null.
      `formatAmount`: 123450 → "$1,234.50", −333 → "−$3.33".
- [ ] `validateEntry` rejects everything in "Entry checks on the server".
- [ ] `mergePull`: an entry's shares are replaced, not merged; an unsent stale update by someone else is
      not replayed; a dropped group takes its entries, conflicts, invites and tokens with it.
- [ ] API handler: a missing or revoked token gives 401; a group the person isn't in gives 404;
      `GET /groups/{id}` for Sam after the $10 dinner and Alex's confirmed 333 gives balance 333 and one
      debt, Jo owes Sam 333; `GET /payments` returns Alex's payment as `received` for Sam and never a
      pending one.
- [ ] API contract: every handler response validates against `docs/api-v1.openapi.yaml` with no
      undocumented fields.

Database (`bun run test:db`):

- [ ] `private.compute_shares()` gives the same parts and shares as every pinned case (generated from
      the case table).
- [ ] `private.may()` and `private.allowed_when_completed()` match every permission case (generated).
- [ ] Sums that don't match, shares or parts that differ from the items, a member from another group, and
      a malformed payment each give `HS422`; someone outside the group gives `HS403`.
- [ ] Handshakes: `payment.record` by one side makes a pending payment with that side's time set;
      `payment.confirm` by the other side confirms it; a second answer gives `HS409`; the starter
      confirming their own payment gives `HS403`; `payment.undo` by someone else gives `HS403`; with a
      name-only counterpart the payment is confirmed at once; `entry.update` and `entry.delete` on a
      payment give `HS422`; answering a pending payment works in a completed group.
- [ ] A stale update by someone else leaves the entry unchanged, creates one open conflict holding the
      base and proposed versions, and pulls to every member; your own stale update is applied.
- [ ] `conflict.resolve` with `kept_current`, `took_proposed` and `merged` each leave the expected entry
      and shares and close the conflict; a second resolve gives `HS409`; a guest resolving gives `HS403`.
- [ ] A stale delete against a newer edit creates a conflict with `proposed` NULL.
- [ ] Roles through `push_changes` (one allowed and one refused call per action, proving each `apply_*`
      asks for the right action): members can add people by name and make invites, and revoke only their
      own; the owner leaving passes ownership to the member who joined first; the last full member leaving
      deletes the group, even with guests left; leaving a completed group works.
- [ ] Guests: can create bills and delete their own; can record and answer their own payments; can't
      update bills, delete others' bills, create groups or create API tokens.
- [ ] Invites: the token is stored only as a hash; preview works with the token; expired (day 15) and
      revoked links fail; joining takes over the name-only person; a taken one can't be claimed again;
      joining twice does nothing; an anonymous caller joins as `guest`; `upgrade_guest()` keeps the same
      member row and makes it `member`.
- [ ] API: a token is stored only as a hash; `api.v1_*` with a revoked or unknown token's hash gives
      `HS401`, and the 61st call in a minute `HS429`; `api.v1_payments` returns only confirmed payments
      involving the token's owner; the cursor pages, picks up a newly joined group and reports a left one;
      `handshake_api` can't select any table or run any function outside `api`.
- [ ] Completing: the owner can complete and reopen, a member gets `HS403`. Completing turns a guest's
      row into a name-only person with the same name and history; deletes their anonymous user when
      they're in no other group, and keeps it when they are; leaves a guest who added an email untouched;
      and the removed guest can no longer pull the group. Bills, edits and invites in a completed group
      give `HS403`; after reopening they work again.
- [ ] Deleting an account: every member row becomes name-only with the same name; ownership passes to the
      earliest full member; a group with no full member left is deleted; pending payments become
      `undone`; API tokens are gone; the `auth.users` row is gone; a payment with that person can then be
      recorded alone and is confirmed at once.
- [ ] Deleted bills are pulled with `deleted_at` set.

By hand, at 375px and 1440px:

- [ ] Add an itemised bill offline: debts change at once; reconnect, and a second browser shows it.
- [ ] Two browsers offline edit the same bill, then reconnect: both see the conflict popup; resolve in
      one; the other shows the result and no popup.
- [ ] Handshake: in browser A record "I paid Sam $10"; browser B (Sam) shows **Confirm**; a third browser
      shows nothing pending; Sam confirms; all three show the payment and the new debt.
- [ ] Create an invite for a name-only person, open it signed out in another browser, continue as guest,
      see the history as that person, add a bill, then add an email and confirm the role is now member.
- [ ] With a guest signed in on another browser, complete the group: the confirmation names the guest and
      anyone still owing; on the guest's next sync the group disappears; the owner sees it under
      Completed, read-only, with the guest's name still on their bills.
- [ ] Delete an account that owes money: the dialog names the debt; the others then see that person as
      name-only and can record a payment with them alone.
- [ ] Create a token in Connected apps, call `GET /api/v1/payments` with it, revoke it, and get 401.

`bun run typecheck`, `bun test`, `bun run test:db` and `bun run build` all exit 0 for each slice.

## Decisions for You

None open. Answered by the owner on 2026-11-03:

| #   | Question                                                 | Answer                                                                                       |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Who covers the rounding cent?                            | The payer: shares round normally and the payer's own share takes the difference (decision 4) |
| 2   | Can a guest remove any entry, or only ones they added?   | Only ones they added                                                                         |
| 3   | Who can complete a group?                                | The owner only: there is no admin role (decision 8)                                          |
| 4   | Can a group be completed while someone still owes money? | Yes, after a confirmation naming them                                                        |
| 5   | Which slices are in the MVP?                             | All seven                                                                                    |

Answered on 2026-11-04:

| #   | Question                                 | Answer                                                                                                        |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 6   | Who adds people and makes invites?       | Owner and members; members revoke only their own invites (decision 8)                                         |
| 7   | What still works in a completed group?   | Reopen, delete and leave                                                                                      |
| 8   | When does a payback count?               | After a handshake: one side records, the other confirms (decision 17)                                         |
| 9   | Who sees debts and payments?             | Everyone sees everything; only the settle buttons and pending payments belong to the two people (decision 18) |
| 10  | Debts between pairs, or simplified?      | Between pairs; with several payers, each payer absorbs their own items' cent (decisions 4 and 18)             |
| 11  | A payment with someone who has no login? | Recorded alone and counts at once; between two name-only people, any full member records it                   |
| 12  | What does Pholio receive?                | Only payments that count, sent and received                                                                   |
| 13  | Account deletion                         | A confirmation dialog; allowed with open debts after a warning; history keeps their name (decision 19)        |

### Confirmed on 2026-11-04

These followed from the answers above and were then confirmed by the owner.

- A payment that counts can't be edited or deleted; a mistake is corrected with a payment the other way.
- In a completed group, a pending payment can still be confirmed or declined (but not undone or
  recorded anew), so a real payback isn't lost because the group closed first.
- A declined or undone payment stays in the two people's history, marked as such, and is never shown to
  the rest of the group.
- A pair has at most one pending payment at a time: while one waits, the debt's button shows "Waiting
  for Sam · Undo", and a second record is refused (`HS409`), so a double tap can't record it twice.

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
- Comments on single bills (the group chat is `docs/chat-spec.md`, slice 8).
- Receipt photos, categories, recurring expenses and refunds.
- Push notifications (the final stage of `docs/chat-spec.md`).
- Export.
- Universal links and App Links for the native apps.

## Risks

- **Deleting guest data is permanent.** When the group is completed, a guest who never added an email
  loses their login and their view of the group, and reopening doesn't bring it back. Mitigations: only
  the login goes (the group's history and balances stay); the guest banner says so from the start; the
  completion dialog names the guests; the owner can re-invite the name.
- **Handshakes left waiting.** A payment the other side never answers stays pending and doesn't count.
  Mitigations: both sides see it on Balances, the starter can Undo, Settle up shows "Waiting for
  confirmation", and nudges (slice 8) remind the other side.
- **Deleting an account is permanent.** The login and profile go; the name stays on the group's history,
  and the person can be invited again as a new account that claims the name.
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
