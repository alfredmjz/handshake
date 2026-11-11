# Handshake design

- **Status:** Second design ("many hands"), 2026-11-08. Replaces the phosphor-screen design of 2026-11-04.
- **Source:** the "Handshake doodle concept" canvas (Claude Design), boards Welcome, Groups, Group, Add
  expense, Settle up and the style sheet.
- **Live reference:** `bun run dev`, then http://localhost:5173/kit (development only).

## Idea

Ink doodles on warm paper. Every category is a hand holding its thing its own way, each with its own
owner (a tattoo, rings, a knit glove, a leather glove, a plaster, rainbow nails, a pen doodle). A group
is a notebook: its cover takes the colour and hand of what the group is mostly for, and opening a group
swings the cover open on its spine. Settling up is two hands shaking on it.

## Rules

1. **Few words.** A hand, a face or a badge says it before a sentence does. One line of help at most.
2. **Build screens from the primitives and containers below**, never one-off styles.
3. **Spacing comes from tokens.** `gap-control` (a label and its field, chips in a row), `gap-stack`
   (items in a group), `gap-section` (between groups), `p-panel` (inside a card), `py-row` (list rows),
   `px-page` (page sides), `gap-x-spread` (between columns). They grow at 640px and 1024px on their own.
4. **Money that stands alone is Funnel Display** (`type-money`, `type-money-lg`, `type-stat`, `type-stat-xl`, or
   `<Amount>`); an amount inside a sentence stays in the text face. Owed to you is cobalt (`text-owed`), you owe is tomato (`text-owe`), everything else ink.
5. **One loud thing per screen.** The cobalt `Button` is the main action; everything else is ink
   outline, a sunken well or plain text.
6. **Category colours mean categories, face colours tell people apart.** Neither ever means money.
7. **No cursive.** Handwriting lives in the drawings, not the type.
8. **Motion answers people.** The cover opens when tapped; hands shake when a payment counts.
   `prefers-reduced-motion` turns all of it off.

## Tokens (`src/styles/globals.css`, `tailwind.config.ts`)

| Role       | Class                                                                                                                               | Value                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Paper      | `bg-background` / `bg-paper`                                                                                                        | `#F8F7F4`                                         |
| Ink        | `text-foreground` / `text-ink`                                                                                                      | `#1C1B19`; muted `#5E5E58`                        |
| Raised     | `bg-card` / `bg-raised`                                                                                                             | `#FCFBF8`: dialogs, the open ledger               |
| Sunken     | `bg-muted` / `bg-sunken`                                                                                                            | `#EDEBE6`: wells, the tab track                   |
| Lines      | `border-border`, `border-border-strong`                                                                                             | ink at 12% and 22%                                |
| Owed       | `text-owed`, `bg-primary`                                                                                                           | cobalt `#2F45D8`, the main action                 |
| Owe        | `text-owe` (text), `bg-owe-mark` (marks)                                                                                            | tomato `#C9381F` / `#E2482F`                      |
| Settled    | `bg-settled`                                                                                                                        | mint                                              |
| Waiting    | `bg-waiting`                                                                                                                        | marigold: not synced, pending                     |
| Categories | `bg-category-{food,drinks,stay,travel,groceries,fun,none}`                                                                          | as on the style sheet                             |
| Type       | `type-display`, `type-h1`…`type-h4`, `type-cover`, `type-body(-lg/-sm)`, `type-label`, `type-caption`, `type-micro`, `type-control` | Funnel Display for headings, Funnel Sans for text |
| Shape      | `rounded-full` (buttons, chips), `rounded-lg`/`rounded-xl` (cards), `rounded-book`, `rounded-sheet`                                 |                                                   |

Every colour takes Tailwind's alpha modifier (`bg-ink/5`, `border-ink/20`).

## Primitives (`src/components/ui/`, shadcn/ui)

`Button` (default, outline, secondary, inverse, destructive, ghost, link; sizes default, sm, lg, icon),
`Card` (outline, well, raised), `Input` (line, boxed, amount, code: the sign-in code and a personal code)
and `Textarea`, `Label`, `Field` and `FieldSet`, `Checkbox`, `ToggleGroup` chips, `Tabs` (the segmented
control), `Dialog` (sheet or screen), `AlertDialog`, `DropdownMenu`, `Popover` (a hover or tap list, e.g.
who joined), `Badge`, `List`/`ListRow`/`ListHeading`, `Separator`, `Skeleton`, `Stack`/`Inline`, `Toaster`.

## Art and containers (`src/components/`)

| Component                                                                 | Use                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `art/hand` `Hand`, `HandDisc`                                             | A category's hand (or `new`, `shake`), alone or on its disc                                                                                                                                                                                                          |
| `art/face` `Face`, `FacePile`, `FaceSlots`                                | A person: drawing and disc colour, never shared inside one group                                                                                                                                                                                                     |
| `art/hands-glyph` `HandsGlyph`                                            | The two hands clasped, shaking or apart, for the sync stamp                                                                                                                                                                                                          |
| `art/doodles`                                                             | `HandshakeMark` (logo), `BellDoodle`, `CheckDoodle`, `ReceiptDoodle`, `SquiggleArrow`                                                                                                                                                                                |
| `art/shake-scene` `ShakeScene`                                            | The settle-up moment                                                                                                                                                                                                                                                 |
| `book-cover` `BookCover`, `Book`, `NewBookButton`                         | A group's cover in the grid; the group's notebook that opens                                                                                                                                                                                                         |
| `screen` `Screen`, `ScreenColumns`, `ScreenHeader`, `Section`, `BackLink` | Page frame and headings                                                                                                                                                                                                                                              |
| `money` `Amount`, `RowAmount`, `standingOf`                               | Money text with its tone                                                                                                                                                                                                                                             |
| `pickers` `PersonPicker`, `PeoplePicker`, `CategoryPicker`                | Paid by, Split between, Category                                                                                                                                                                                                                                     |
| `editor-dialog` `EditorDialog`                                            | Full screen on phones, a dialog from 640px; a form with one save                                                                                                                                                                                                     |
| `confirm-dialog` `ConfirmDialog`                                          | One question, the action named on its button                                                                                                                                                                                                                         |
| `notices` `EmptyState`, `Notice`                                          | Empty screens; a band that stays until acted on (guest, completed)                                                                                                                                                                                                   |
| `sync-status` `SyncStatusBadge`, `SyncStamp`                              | A stamp: the two hands on the category blob. Mint and clasped when synced, shaking while syncing, marigold with a count tag while changes wait, a dashed outline with the hands apart offline, tomato with the hands apart on an error; the words are in the tooltip |
| `nudge-bell` `NudgeBell`                                                  | The header bell: nudges to you, unseen count, each opens Balances                                                                                                                                                                                                    |
| `guest-banner` `GuestBanner`                                              | The guest band on every screen, with Keep my data (email, then code) and their personal code                                                                                                                                                                         |
| `guest-code` `MyGuestCodes`                                               | A guest's personal code, one line per group, with Copy (banner, Settings)                                                                                                                                                                                            |
| `guest-code-sheet` `GuestCodeSheet`                                       | Once, after a guest joins: "Your code is 7KQ-M2D", Copy                                                                                                                                                                                                              |
| `copy-button` `CopyButton`, `copyText`                                    | An icon button that copies a code or link, with its toast                                                                                                                                                                                                            |
| `join-code-form` `JoinCodeForm`                                           | "Have a group code?": a code (`HX7-K2P`, any case) or a pasted link, opens the join screen                                                                                                                                                                           |
| `group-faces` `GroupFaces`                                                | Gives every person in a group a face no one else there has                                                                                                                                                                                                           |
| `editors/expense-editor` `ExpenseEditor`                                  | Add or edit a bill: amount, items, category, Paid by, Split between                                                                                                                                                                                                  |
| `editors/payment-editor` `PaymentEditor`                                  | Record a payment between two people, preset from a debt                                                                                                                                                                                                              |
| `editors/payment-arrow` `PaymentArrow`                                    | Payer face, squiggle with the amount tag, receiver face                                                                                                                                                                                                              |
| `editors/shake-confirmation` `ShakeConfirmation`                          | The cobalt "Jo paid you $50.00 / Settled" moment                                                                                                                                                                                                                     |
| `group/ledger-page` `LedgerPage`                                          | The page under a group's cover: name, faces, your balance                                                                                                                                                                                                            |
| `group/entry-list-row` `EntryListRow`                                     | One bill or payment in a list                                                                                                                                                                                                                                        |
| `group/debt-card` `DebtCard`                                              | A debt or payment between two people, with its buttons                                                                                                                                                                                                               |
| `group/payment-buttons` `PaymentButtons`                                  | Settle, Decline with a note, Undo                                                                                                                                                                                                                                    |
| `group/nudge-button` `NudgeButton`                                        | Nudge, "Nudged today", "Jo hasn't joined"                                                                                                                                                                                                                            |
| `group/nudge-notice` `NudgeNotice`                                        | "Alex nudged you · $20.00" on your debt card, with Settle                                                                                                                                                                                                            |
| `group/name-dialog` `NameDialog`                                          | One name to type (Add person, Rename); a name already in the group is refused inline                                                                                                                                                                                 |
| `group/group-code` `GroupCode`                                            | People tab: the group code, Copy, Copy link, Share, the owner's Reset code, "3 joined · Ann, Jo and Sam"                                                                                                                                                             |
| `group/conflict-popup` `ConflictPopup`, `group/conflict-resolver`         | Once per new conflict; the side-by-side resolver                                                                                                                                                                                                                     |

## Layout

Phones first (375px), one column with `px-page` gutters. From 1024px a group uses `ScreenColumns`: the
notebook and its two main buttons on the left, the tabs on the right. Lists and forms stay in a
centred column (`Screen width="narrow"`); the Groups grid grows from two covers to four.

```
375px                     1440px
┌─────────────────┐       ┌──────────────────────────────────────────┐
│ ‹ Groups      … │       │ handshake                    [🤝 Synced] │
│ ┌─────────────┐ │       │ ‹ Groups                               … │
│ │ cover  ✋   │ │       │ ┌──────────────┐  [Entries|Balances|People]│
│ │ Japan 2027  │ │       │ │ cover   ✋   │  Tue 4 Nov               │
│ └─────────────┘ │       │ │ Japan 2027   │  ◐ Taxi to Shibuya  $40  │
│ [Add] [Settle]  │       │ └──────────────┘  ◐ Jo paid Priya    —    │
│ [Ent|Bal|Peop]  │       │ [Add expense] [Settle up]                 │
│ ◐ Taxi    $40   │       │                                          │
└─────────────────┘       └──────────────────────────────────────────┘
```

## Order

Lists and pickers sort by the label people read, with two exceptions: Paid by and Split between put
you first, and the categories keep the style sheet's order (Food, Drinks, Stay, Travel, Groceries, Fun).
