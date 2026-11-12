# Handshake design

- **Status:** The app's one design ("many hands", refined as the sketchbook), 2026-11-12. It replaces every earlier
  design; there is no other UI to keep in step with.
- **Source:** the "Handshake doodle concept" canvas (Claude Design), boards Welcome, Groups, Group, Add
  expense, Settle up and the style sheet.
- **Live reference:** `bun run dev`, then http://localhost:5173/kit (development only).

## Idea

Ink doodles on warm paper. Every category is a hand holding its thing its own way, each with its own
owner (a tattoo, rings, a knit glove, a leather glove, a plaster, rainbow nails, a pen doodle). A group
is a notebook on the shelf: its cover takes the colour and hand of what the group is mostly for. Inside, a group
is a running receipt of what it spent: every bill at its full cost (its items under it), the total, and your share;
it prints as you open the group and feeds on a line when a bill is added. Who owes whom lives in Balances. Settling up is two hands shaking on it.

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
7. **Handwriting is for notes, never for money or controls.** `type-hand` and `type-hand-lg` (Shantell Sans) set day
   headings, empty screens and small margin notes; amounts stay Funnel Display and buttons Funnel Sans. No cursive.
8. **Motion answers people, and settles like a hand put down.** Fast at first, then easing in, never at a constant
   speed (`ease-out`, `ease-spring`, `ease-bounce` for the few big moments; `duration-press`, `duration-quick`,
   `duration-settle`, `duration-moment`). Quiet day to day, alive at the big moments: a receipt printing as a group opens, a
   bill landing, amounts rolling to their new value, hands shaking when a payment counts.
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

Cover colours come from the colour board (`src/lib/cover-colors.ts`): 18 hues by 5 shades, stored as keys and drawn
as HSL triples like the tokens. They colour books only; category colours still mean categories.

A cover's sticker (`src/lib/cover-stickers.ts`) is what tells the books apart at a glance: a hand drawn straight
onto the cover (by default the hand of what the group is mostly for), or an emoji or a picture of the group's own
as a die-cut sticker (`.sticker`: a paper edge, a soft shadow, stuck on 5° crooked). It fills about half the
cover's width, so it grows with the book. The picker puts the emoji the group's name brings to mind first
("Japan 2027" → 🇯🇵 🗾 🍣). Where the system has no flag emoji (Windows), the `country-flag-emoji-polyfill` font
draws them, served with the app.

Every colour takes Tailwind's alpha modifier (`bg-ink/5`, `border-ink/20`).

## Primitives (`src/components/ui/`, shadcn/ui)

`Button` (default, outline, secondary, inverse, destructive, ghost, link; sizes default, sm, lg, icon),
`Card` (outline, well, raised), `Input` (line, boxed, amount, code: the sign-in code and a personal code)
and `Textarea`, `Label`, `Field` and `FieldSet`, `Checkbox`, `ToggleGroup` chips, `Tabs` (the segmented
control), `Dialog` (sheet or screen), `AlertDialog`, `DropdownMenu`, `Popover` (a hover or tap list, e.g.
who joined), `Badge`, `List`/`ListRow`/`ListHeading`, `Skeleton`, `Stack`/`Inline`, `Toaster`.

## Art and containers (`src/components/`)

| Component                                                                 | Use                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `art/hand` `Hand`, `HandDisc`                                             | A category's hand (or `new`, `shake`), alone or on its disc                                                                                                                                                                                                                                                                                                                                   |
| `art/face` `Face`, `FacePile`, `FaceSlots`                                | A person: drawing and disc colour, never shared inside one group                                                                                                                                                                                                                                                                                                                              |
| `art/hands-glyph` `HandsGlyph`                                            | The two hands clasped, shaking or apart: the logo and the sync state                                                                                                                                                                                                                                                                                                                          |
| `art/doodles`                                                             | `HandshakeMark` (the logo, the whole drawing), `BellDoodle`, `CheckDoodle`, `ReceiptDoodle`, `SquiggleArrow`                                                                                                                                                                                                                                                                                  |
| `art/shake-scene` `ShakeScene`                                            | The settle-up moment                                                                                                                                                                                                                                                                                                                                                                          |
| `book-cover` `BookCover`, `NewBookButton`                                 | A group's cover on the shelf, in the group's own colour (deep colours take paper-coloured type); its sticker above the name; the title shrinks with a narrow cover so a long word fits                                                                                                                                                                                                        |
| `cover-sticker` `CoverSticker`                                            | A group's sticker in a box of any size: a hand drawn straight on, or an emoji or picture as a die-cut sticker. On covers, the receipt's corner and the picker                                                                                                                                                                                                                                 |
| `sticker-picker` `StickerPicker`                                          | The default hand, the emoji the group's name brings to mind, the seven hands, a few common emoji, any emoji typed in, or Upload a picture (made small on the device). In Start a group and the group menu's Cover                                                                                                                                                                             |
| `color-board` `ColorBoard`                                                | The colour board, laid out like a contribution graph: hue across (red round to pink, labelled every third column), shade down (pale to deep), the chosen hue's five shades as the legend. Press and drag across it to sweep through the colours (nearest cell under the pointer, mouse, pen or touch), click one, or walk it with the arrow keys. In Start a group and the group menu's Cover |
| `screen` `Screen`, `ScreenColumns`, `ScreenHeader`, `Section`, `BackLink` | Page frame and headings                                                                                                                                                                                                                                                                                                                                                                       |
| `money` `Amount`, `RowAmount`                                             | Money text with its tone                                                                                                                                                                                                                                                                                                                                                                      |
| `pickers` `PersonPicker`, `PeoplePicker`, `CategoryPicker`                | Paid by, Split between, Category                                                                                                                                                                                                                                                                                                                                                              |
| `editor-dialog` `EditorDialog`                                            | Full screen on phones, a dialog from 640px; a form with one save                                                                                                                                                                                                                                                                                                                              |
| `confirm-dialog` `ConfirmDialog`                                          | One question, the action named on its button                                                                                                                                                                                                                                                                                                                                                  |
| `notices` `EmptyState`, `Notice`                                          | Empty screens; a band that stays until acted on (guest, completed)                                                                                                                                                                                                                                                                                                                            |
| `sync-status` `SyncMark`, `useSyncState`                                  | The header logo's hands: clasped when synced, shaking while syncing, let go offline (faded) or on an error (tomato dot); a marigold count tag while changes wait. The words are in the link's label and the account menu, with Sync now                                                                                                                                                       |
| `nudge-bell` `NudgeBell`                                                  | The header bell: nudges to you, unseen count, each opens Balances                                                                                                                                                                                                                                                                                                                             |
| `guest-banner` `GuestBanner`                                              | The guest band on every screen, with Keep my data (email, then code) and their personal code                                                                                                                                                                                                                                                                                                  |
| `guest-code` `MyGuestCodes`                                               | A guest's personal code, one line per group, with Copy (banner, Settings)                                                                                                                                                                                                                                                                                                                     |
| `guest-code-sheet` `GuestCodeSheet`                                       | Once, after a guest joins: "Your code is 7KQM-2DXH", Copy                                                                                                                                                                                                                                                                                                                                     |
| `copy-button` `CopyButton`, `copyText`                                    | An icon button that copies a code or link, with its toast                                                                                                                                                                                                                                                                                                                                     |
| `join-code-form` `JoinCodeForm`                                           | "Have a code?": a group code (`HX7-K2P`), a personal code (`7KQM-2DXH`) or a link, opens the join screen                                                                                                                                                                                                                                                                                      |
| `group-faces` `GroupFaces`                                                | Gives every person in a group a face no one else there has                                                                                                                                                                                                                                                                                                                                    |
| `editors/expense-editor` `ExpenseEditor`                                  | Add or edit a bill: amount, items, category, Paid by, Split between                                                                                                                                                                                                                                                                                                                           |
| `editors/payment-editor` `PaymentEditor`                                  | Record a payment between two people, preset from a debt                                                                                                                                                                                                                                                                                                                                       |
| `editors/payment-arrow` `PaymentArrow`                                    | Payer face, squiggle with the amount tag, receiver face                                                                                                                                                                                                                                                                                                                                       |
| `editors/shake-confirmation` `ShakeConfirmation`                          | The cobalt "Jo paid you $50.00 / Settled" moment                                                                                                                                                                                                                                                                                                                                              |
| `group/group-receipt` `GroupReceipt`                                      | The top of a group: a torn-edge receipt of its bills at full cost, oldest first (the last five, then "3 earlier"), items indented under a bill of several, the total and your share; prints on arrival, feeds and prints the new line when a bill is added                                                                                                                                    |
| `group/entry-list-row` `EntryListRow`                                     | One bill or payment in a list                                                                                                                                                                                                                                                                                                                                                                 |
| `group/debt-card` `DebtCard`                                              | A debt or payment between two people, with its buttons                                                                                                                                                                                                                                                                                                                                        |
| `group/payment-buttons` `PaymentButtons`                                  | Settle, Decline with a note, Undo                                                                                                                                                                                                                                                                                                                                                             |
| `group/nudge-button` `NudgeButton`                                        | Nudge, "Nudged today", "Jo hasn't joined"                                                                                                                                                                                                                                                                                                                                                     |
| `group/nudge-notice` `NudgeNotice`                                        | "Alex nudged you · $20.00" on your debt card, with Settle                                                                                                                                                                                                                                                                                                                                     |
| `group/name-dialog` `NameDialog`                                          | One name to type (Add person, Rename); a name already in the group is refused inline                                                                                                                                                                                                                                                                                                          |
| `group/group-code` `GroupCode`                                            | People tab: the group code, Copy, Copy link, Share, the owner's Reset code, "3 joined · Ann, Jo and Sam"                                                                                                                                                                                                                                                                                      |
| `group/conflict-popup` `ConflictPopup`, `group/conflict-resolver`         | Once per new conflict; the side-by-side resolver                                                                                                                                                                                                                                                                                                                                              |

## Sketchbook

The page is a dotted sketchbook sheet (the dots are on `body`; cards and dialogs sit on it as plain paper). Pen marks
from `art/marks` say what matters without words, and each draws itself once: `Circled` round the one number a
screen is about (a group's total), `Underlined` under one word of the welcome title. A list row's title gets a highlighter
swipe (`marker marker-hover`) while the row is pointed at. One mark per screen region; a screen with three circles has
none. `MarginDoodles` sit in the side margins from 1320px only. Nothing on a screen loops on its own: drawings move
only while pointed at.

A bill's note is written in the margin (`group/entry-note`): `type-hand-lg` on the bill's page, tap to edit in place
for anyone who may edit the bill.

`Signatures` (`art/signatures`) is the handshake on paper: a dotted line each for the payer and the receiver, signed
in their own name. One signature and a cross is a payment still waiting (on its debt card, in place of badges); on
the cobalt confirmation both sign, one after the other, and only then do the sleeves come in and shake.

## Hairline figures

Hands mark things that exist; a hairline figure fills a waiting space, small and beside its one line, still
until the pointer is over it (no idle play). `Plot` (from `@lucasmarkes/hairline`) for "No expenses yet", and two of
our own on Hairline's kernel (`src/vendor/hairline`, from the hairline-create skill), mounted with `HairlineFigure`:

- `figures/square`, Balances' empty state ("You're all square" or "Nothing owed yet"): four small cubes on the
  floor, seen corner-on so three faces show, inside an invisible boundary the width of the frame (the cubes keep their
  size; the floor grows). The cursor knocks the cube it runs into the way the cursor is going (left, right, up or
  down), as hard as it was moving; a cube rolls, knocks into the others and passes some of its speed on, bounces
  softly off the boundary, slows by friction and settles flat on its nearest face.
- `figures/queue`, People's empty state ("No one has joined yet", when the group is only you): five people at a
  locked door, backs to us. The one under the pointer turns round, eyes lit, and the neighbours glance back in a
  wave; the padlock is the bright mark at rest.

Every empty tab is laid out the same, with `EmptyState`: the figure in one frame (the tab's width, `h-56`), then
one line in `type-hand-lg`. A figure drawn on Hairline's 400 × 320 board fills the frame's height (`h-full`); the
cubes, drawn a pixel to a unit, fill the whole frame.

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
