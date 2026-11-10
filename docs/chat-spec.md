# Group chat, nudges and live updates (slice 8)

- **Status:** Agreed design (2026-11-04); builds after the MVP's seven slices
- **Created:** 2026-11-04
- **Author:** Claude Code, for Alfred Mah
- **Builds on:** `docs/shared-ledger-spec.md` (debts, handshakes, roles), `docs/architecture.md` (sync,
  module map)
- **Estimated Time:** about 4 days, plus the push stage later (about 2 days)

## Quick Context

After the MVP, a group has bills, debts and handshake payments, synced offline-first with
`push_changes`/`pull_changes` and no Realtime. Friends still have to leave the app to talk about the
trip or remind someone to pay. This spec adds:

1. **A chat per group**: text messages, replies and pins.
2. **Nudges**: the person owed reminds someone who owes them, and the nudge leads straight into a
   handshake.
3. **Live updates**: a change made on one device shows on the others within a second while the app is
   open, for everything in the group, not just chat.
4. **Later, push notifications** on iOS, Android and the web, so chat and nudges reach people who aren't
   looking at the app.

Handshake still never calls Pholio, and Pholio never sees chat or nudges.

## Design Decisions

### 1. One chat per group

- **Chosen Solution:** every group has exactly one chat, created with the group. Owner, members and
  guests can read and write; name-only people can't (they have no login).
- **Alternatives considered:** a thread per bill (later, if wanted; it would reuse the same messages
  table with an `entry_id`).

### 2. Messages: text, replies, pins, delete your own

- **Chosen Solution:**
  - Text only, 1–2,000 characters. No editing, reactions, photos or files.
  - **Reply:** a message can quote one earlier message. The reply carries a snippet (the author's name
    and up to 120 characters), stored with it by the server, so it shows even if the original isn't on
    this device. Tapping it jumps to the original. One level only, no threads.
  - **Delete your own:** the text is removed on the server and the message shows as deleted (an icon and
    "Deleted"); replies to it show "Original message deleted".
  - **Pin:** the owner and members can pin up to 3 messages, shown newest first in a strip above the
    chat; anyone who can pin can unpin. A 4th pin is refused until one is unpinned.
- **Why:** the smallest set that makes a group chat useful, with a data model that stays one table.

### 3. Status is shown with icons, never system text

- **Chosen Solution:** on your own messages: 🕓 waiting to send, ✓ the server has it, ⚠ it couldn't be
  saved (tap to retry). No delivered or read ticks, no "typing…". The one piece of system text kept is
  the small date chip between days ("Today", "Mon 2 Nov").
- **Unread:** each group shows an unread count on the Groups list and on its Chat tab. The "last read"
  point is kept on each device, so it needs no server data.
- **Why:** the owner: a chat already has plenty of text; the system shouldn't add more.

### 4. Nudges are private, once a day, and lead to a handshake

- **Chosen Solution:**
  - The person owed can nudge anyone who owes them, once per 24 hours per person. The nudge carries the
    debt at that moment.
  - Only those two see it. The nudged person sees a card in their view of the chat, "Alex nudged you ·
    $20.00", with **I paid**, which opens the payment editor filled in and starts a handshake. The sender
    sees "Nudged Jo" in theirs.
  - A name-only person can't be nudged; their button reads "Jo hasn't joined".
  - Nudges are rows synced to the whole group; screens show them only to the two people.
- **Why:** a reminder without public pressure, and one tap from reminder to the payment that settles it.

### 5. A completed group's chat is read-only

- **Chosen Solution:** no messages, pins or nudges while the group is completed; it reopens with the
  group.

### 6. No report or block

- **Chosen Solution:** members are friends who invited each other, so there is no report or block.
- **Risk:** Apple's App Review guideline 1.2 asks apps with user-generated content to offer both. The
  submission notes should explain that chats are private to invited friends; if review insists, report
  and block become a small addition (a report row, and hiding a blocked member's messages on your
  device).

### 7. Live updates: Realtime carries a signal, data still comes through the pull

- **Chosen Solution:**
  - When `push_changes` (or an online function such as `join_group`) changes a group, it sends one
    Supabase Realtime **Broadcast** on the private channel `group:<id>` with `{ "version": <head> }`,
    through `realtime.send()`. Only members may subscribe (an RLS policy on `realtime.messages`).
  - Each device subscribes to its groups' channels while the app is open. A signal does one thing:
    `requestSync()`. All data still arrives through `pull_changes` and the message feed, so exactly-once,
    ordering, offline use and the transport seam are unchanged.
  - If the socket is down, the existing triggers still work (on change, on reopen, once a minute), and
    the device syncs every 5 seconds while a chat screen is open.
  - When the app comes back to the foreground (Capacitor `appStateChange`, or `visibilitychange` on the
    web), it resubscribes and syncs.
- **Why:** it is how WhatsApp and Messenger work: a socket is only the fast path; the stored log is the
  truth. Supabase Realtime is already in the stack, so there is no new service, key or server.
- **Limits:** Free plan: 200 concurrent connections, 100 messages per second, 2 million messages a
  month; Pro: 500 connections, then $10 per 1,000. A signal is best effort with no history, which is
  fine because the pull catches up. On a phone the socket closes in the background; that is what push
  (decision 9) is for.
- **Alternatives considered:** Postgres Changes (data would bypass the pull and the merge rules); Ably,
  Pusher or PubNub (a new vendor and keys); a self-hosted socket server (Vercel functions can't hold
  sockets); polling only (seconds of delay in a chat).
- This revises the `AGENTS.md` rule "Don't enable Supabase Realtime" to "Realtime carries only change
  signals; data comes through `pull_changes`".

### 8. Chat history: newest first, a cache of 500, endless scroll

- **Chosen Solution:**
  - Messages don't travel in `pull_changes`. They have their own feed so the **newest arrive first**:
    `pull_messages(group, since)` returns what changed since the device's message cursor, newest first,
    up to 500; `message_history(group, before, limit)` returns older ones.
  - Each device keeps the **newest 500 messages per group**, always, so every chat opens at once and reads
    offline. Older messages are fetched as you scroll up and kept until the app next starts, when the
    cache trims back to 500. If more than 500 changed while a device was away, it keeps the newest 500
    and drops the rest of its cache for that group.
  - The chat is one endless scroll (no pages or "load more"): it opens at your first unread message (or
    the newest), shows a ↓ button with a count to jump back down, and loads around a quoted message when
    you tap a reply that isn't on the device.
  - The list is virtualised with `react-virtuoso` (MIT, the core `Virtuoso` list) behind our own
    `ChatList` component.
- **Why:** WhatsApp's feel (the latest messages first, history as you scroll) with a predictable amount
  of storage. 500 short messages are well under 1 MB.
- **Alternatives considered:** the whole history on every device (the owner chose a cache); messages in
  `pull_changes` (oldest first, so a new device would see last year's messages before today's).

### 9. Push notifications: the final stage

- **Chosen Solution** (built later, designed now so the data model has room):
  - `@capacitor-firebase/messaging` (Capawesome) on iOS, Android and the web, so there is one
    registration path, and **Firebase Cloud Messaging** as the one sender (Apple's APNs key is uploaded
    to Firebase; browsers use FCM's Web Push).
  - `vite-plugin-pwa` switches to `injectManifest` so our service worker handles `push` events next to
    the offline cache. On iPhone, web push works only for a site added to the Home Screen (iOS 16.4+).
  - When `push_changes` writes a message, a nudge or a handshake request, it also writes a
    `notification_outbox` row in the same transaction. A trigger calls a Vercel function
    `api/internal/push` through `pg_net` with a shared secret; the function looks up the recipients'
    `push_devices` and sends through FCM's HTTP v1 API with plain `fetch` (no `firebase-admin`, so it
    runs on Bun).
  - Notification text respects the group: "Sam: see you at 7", "Alex nudged you", "Jo says they paid
    you".
- **Costs:** FCM is free. Publishing needs the Apple Developer Program ($99 a year) and a Google Play
  developer account ($25 once).

## Data Model

### Server (`supabase/migrations/010_chat.sql`)

`chat_messages`

| Column                | Type                      | Notes                                                     |
| --------------------- | ------------------------- | --------------------------------------------------------- |
| `id`                  | UUID PK                   | Made on the device                                        |
| `group_id`            | UUID → groups             |                                                           |
| `member_id`           | UUID → group_members      | The author                                                |
| `seq`                 | BIGINT                    | The group version when it was stored; the message order   |
| `body`                | TEXT NULL                 | 1–2,000 characters; NULL once deleted                     |
| `reply_to_id`         | UUID NULL → chat_messages |                                                           |
| `reply_snippet`       | JSONB NULL                | `{ authorMemberId, authorName, text }`, set by the server |
| `sent_at`             | TIMESTAMPTZ               | The device's clock, shown next to the message             |
| `created_at`          | TIMESTAMPTZ               | Server time                                               |
| `deleted_at`          | TIMESTAMPTZ NULL          |                                                           |
| `pinned_at`           | TIMESTAMPTZ NULL          |                                                           |
| `pinned_by_member_id` | UUID NULL → group_members |                                                           |
| `row_version`         | BIGINT                    | Moves on every change (send, delete, pin, unpin)          |

`nudges`

| Column           | Type                 | Notes                     |
| ---------------- | -------------------- | ------------------------- |
| `id`             | UUID PK              | Made on the device        |
| `group_id`       | UUID → groups        |                           |
| `from_member_id` | UUID → group_members | The person owed           |
| `to_member_id`   | UUID → group_members | The person who owes       |
| `amount_cents`   | BIGINT > 0           | The debt when it was sent |
| `created_at`     | TIMESTAMPTZ          |                           |
| `row_version`    | BIGINT               |                           |

Indexes: `(group_id, seq)` and `(group_id, row_version)` on messages; `(group_id, row_version)` and
`(from_member_id, to_member_id, created_at)` on nudges. RLS: members `SELECT` both through
`is_group_member()`. Every write takes `private.next_group_version()`.

Later, for push (decision 9): `push_devices (id, user_id, platform, token, created_at, last_seen_at)` and
`notification_outbox (id, user_id, kind, payload, created_at, sent_at)`, neither readable by clients.

### Device (Dexie version 3)

- `messages`: `id, groupId, [groupId+seq]`; a message not yet on the server has no `seq` and sorts last
  by `sentAt`.
- `messageCursors`: `groupId` → the last message version this device has.
- `nudges`: `id, groupId`.
- `chatReads`: `groupId` → the last `seq` read here (local only, never synced).

## Sync Changes

### New mutations

| Type             | Fields                                           | Action checked (spec decision 8 matrix)     |
| ---------------- | ------------------------------------------------ | ------------------------------------------- |
| `message.send`   | `messageId, groupId, body, replyToId, sentAt`    | `message.send` (owner, member, guest)       |
| `message.delete` | `messageId, groupId`                             | `message.delete.own` (owner, member, guest) |
| `message.pin`    | `messageId, groupId, pinned` (`true` or `false`) | `message.pin` (owner, member)               |
| `nudge.send`     | `nudgeId, groupId, toMemberId, amountCents`      | `nudge.send` (owner, member, guest)         |

None of them is allowed in a completed group. Server checks: `HS422` for a body that is empty or too
long, replying to a message in another group, a 4th pin, nudging someone who doesn't owe you right now
(`private.debt_between()` from share parts and confirmed payments) or who has no login, or a second
nudge to the same person within 24 hours; `HS403` for deleting someone else's message.

### Pull additions

`pull_changes` returns, per group, `message_version` (the newest message change), `pins` (the pinned
messages in full, at most 3, so the strip shows without the cache) and `nudges`. Message bodies are not in
`pull_changes`.

### Message feed (online, `SECURITY INVOKER`, relying on RLS)

- `pull_messages(p_group_id UUID, p_since BIGINT, p_limit INT DEFAULT 500)` → `{ messages, version,
gap }`: messages whose `row_version` is past `p_since`, newest first. `gap` is true when more than
  `p_limit` changed; the device then keeps only these and drops the rest of its cache for the group.
- `message_history(p_group_id UUID, p_before_seq BIGINT, p_limit INT DEFAULT 100)` → messages with `seq`
  below `p_before_seq`, newest first.

During a sync, after `pull_changes`, the device calls `pull_messages` for each group whose
`message_version` is past its message cursor.

### Change signals

At the end of `push_changes`, and in every online function that changes a group, one
`realtime.send(jsonb_build_object('version', head_version), 'changed', 'group:' || group_id, TRUE)` per
group changed in that call. RLS on `realtime.messages` lets an authenticated user receive a topic only
when it is `group:<uuid>` for a group they belong to.

## Screens

1. **Group → Chat tab** (a fourth tab after Balances, Entries and People), with the unread count.
   - The pinned strip on top (up to 3), each tapping to its message.
   - Messages with author, time and status icon; date chips between days; a reply shows its quote.
   - Long-press (or the message menu on desktop): Reply, Pin or Unpin (owner and members), Delete (your
     own).
   - The composer with the reply preview when replying. Read-only with no composer in a completed group.
   - Nudge cards, only to the two people involved.
2. **Balances:** next to each debt owed to you, **Nudge** (disabled with "Nudged today" within 24 hours,
   "Jo hasn't joined" for a name-only person).
3. **Groups list:** an unread count on each group.

## Implementation Guide

Slice 8, after the MVP, in the same three passes:

1. **Database (chat 2 or its successor):** `supabase/migrations/010_chat.sql`: both tables, the four
   mutations, the feed functions, `private.debt_between()`, the `pull_changes` additions, the change
   signals and the `realtime.messages` policy; the matrix rows added to `tests/fixtures/permission-cases.ts`.
   Tests: `supabase/tests/chat.test.sql`, `supabase/tests/nudges.test.sql`.
2. **Logic (chat 3 or its successor):** the intents in `planChange`; `applyMutation` for the four types;
   the message history module and the signal subscription (`docs/architecture.md` §9); Dexie version 3.
   Tests: `tests/lib/sync/messages.test.ts`, `tests/lib/changes.test.ts` additions. `AGENTS.md`'s Realtime
   rule is reworded in the same change.
3. **Screens:** the Chat tab, nudges, unread counts, `react-virtuoso`.
4. **Later, push:** `push_devices`, `notification_outbox`, `api/internal/push`, the plugin and the
   service worker.

## Testing Checklist

Unit (`bun test`):

- [ ] `planChange`: a message to a completed group plans `HS403`; a guest can't pin; deleting someone
      else's message plans `HS403`; nudging someone who doesn't owe you, a name-only person, or the same
      person twice in 24 hours is refused; **I paid** on a nudge plans a `payment.record` for the nudge's
      amount with you as payer.
- [ ] Message history: a sync pulls changed messages newest first and moves the cursor; a `gap` drops the
      group's older cache; scrolling up adds older messages; restarting trims to the newest 500; a
      message with no `seq` sorts last; unread counts only others' messages past the last read `seq`.
- [ ] Status: a message is 🕓 while its mutation is in the outbox, ✓ once it has a `seq`, ⚠ when rejected.

Database (`bun run test:db`):

- [ ] Sending stores `seq` from the group version and the server's `reply_snippet`; deleting clears the
      body and blanks the snippet in replies; a 4th pin gives `HS422`; unpinning frees a slot.
- [ ] `pull_messages` returns only changes past the cursor, newest first, with `gap` past the limit;
      `message_history` pages below a `seq`; a non-member gets nothing.
- [ ] Nudges: allowed only while the target owes the sender, once per 24 hours per pair; `HS422`
      otherwise.
- [ ] Every `push_changes` call that changes a group sends exactly one signal per group (checked in
      `realtime.messages`); a non-member can't read the topic.
- [ ] Messages, pins and nudges in a completed group give `HS403`.

By hand, at 375px and 1440px:

- [ ] Two browsers in one group: a message sent in one shows in the other within a second; with the
      network blocked for Realtime only, it shows within 5 seconds while the chat is open.
- [ ] Offline, send a message (🕓), reconnect (✓), and see it in the other browser.
- [ ] Scroll up through more than 500 messages; restart; the chat opens instantly at the newest.
- [ ] Nudge Jo from Balances; Jo sees the card, taps **I paid**, you confirm; nobody else saw the nudge.

## Confirmed on 2026-11-04

- A nudge's amount is the debt when it was sent and doesn't update; **I paid** opens the editor with that
  amount, which can be changed.

## Assumptions to confirm

- A deleted account's messages keep their name, like their bills and payments (spec decision 19).
- There are no @mentions; people are named in plain text.

## Out of Scope

- Threads per bill, reactions, editing, photos and files, voice notes.
- Read receipts, delivered ticks and typing indicators.
- @mentions, search, muting a chat.
- Report and block (decision 6).

## Risks

- **App Review and user-generated content** (decision 6).
- **A dropped socket looks like lag.** The 5-second poll while a chat is open and the resync on resume
  keep the gap short.
- **Realtime quotas.** Free projects also pause after 7 days without activity; move to Pro before real
  groups rely on the app.
- **Message cache and long absences.** A device away for weeks in a busy group keeps only the newest 500
  on its next sync; older ones load on scroll, so nothing is lost, only fetched later.
- **Signals to removed members.** Channel access is checked when a device subscribes and then cached, so
  a removed member may receive "changed" signals until they reconnect. Signals carry only a version
  number.
