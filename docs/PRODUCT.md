# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

One React build ships as a PWA and inside Capacitor apps for iOS and Android. The native apps bundle the web
build; they do not adopt native design languages.

## Users

Any group of friends sharing costs, usually on a trip, released publicly. One person starts a group and the
others join with its code. Some never make an account (guests), and some never open the app at all (people
added by name only). People use it on their phones, often abroad with poor or no signal.

## Product Purpose

Handshake keeps track of who owes whom inside a group. People record bills as they happen, see the debts
between each pair of people, and record paybacks. No money moves in or out: the app only keeps the record.
It works when the people in a group can see what they owe and settle it without arguing, until the owner
marks the group completed.

## Positioning

- **A payback counts only after a handshake.** One side records it, the other confirms it. Nobody can mark
  themselves paid alone.
- **Debts stay between pairs.** What Sam owes Alex comes from their own bills, not a group-wide shuffle that
  has people paying strangers.
- **Works offline.** Everything except joining a group works with no signal and syncs later.
- **Friends join without an account.** A group code lets people in as guests, and people who never install
  the app can be added by name.

## Operating Context

- A trip: someone pays for dinner, a taxi or a stay, and adds it right away or later from the receipt.
- Bills are made of items; each item has who paid and who shares it, split equally.
- Paying back happens outside the app (cash, bank transfer); Handshake records it and both sides confirm.
- Nudges remind someone who owes you, at most once a day, inside the app.
- One chat per group.
- The owner checks who has settled, then completes the group, which ends guests' access.
- Pholio, the owner's personal finance app, reads payments that count through a read-only API with a token
  the person creates and can revoke.

## Capabilities and Constraints

- Scope is shared expenses within a group, plus the chat and nudges that go with them. Trip planning is
  not part of the product.
- Dollars only: amounts show `$` with no currency codes, pickers or exchange rates.
- Everyone in a group sees every bill, item, share, debt and confirmed payment. Only the settle buttons
  between two people, a payment awaiting its handshake, and nudges are private to the two of them.
- Roles: one owner per group, members (with accounts) and guests (no email). There is no admin role.
- Joining needs the server; native universal links are not set up yet, so a "Have a code?" box takes codes
  and pasted links.
- Specs: `docs/shared-ledger-spec.md` (behaviour), `docs/chat-spec.md` (chat and nudges),
  `docs/architecture.md` (structure).

## Brand Commitments

- Name: Handshake. Settling up is two people shaking on it.
- Voice: few words; a drawing or badge says it before a sentence does, one line of help at most.
- The words in the app are group, owner, member, guest, bill, debt, payment, handshake, nudge, settled and
  completed, and the app avoids balance for a debt, archived, admin, transfer and IOU.

## Evidence on Hand

None. There are no users, testimonials, usage numbers, press or pricing yet; do not invent them.

## Product Principles

1. Record, never move money.
2. Both sides agree before a payment counts.
3. Nothing depends on a signal except joining.
4. Nobody is shut out for not having an account.
5. Everyone in a group sees the same numbers.

## Accessibility & Inclusion

WCAG 2.2 AA on every screen, on the web and in the native apps. Motion turns off under
`prefers-reduced-motion`.
