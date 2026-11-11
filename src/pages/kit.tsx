import { useState } from "react";
import { MoreHorizontal, Plus, Trash2 } from "lucide-react";

import { BellDoodle, CheckDoodle, HandshakeMark, ReceiptDoodle, SquiggleArrow } from "@/components/art/doodles";
import { Face, FacePile } from "@/components/art/face";
import { Hand, HandDisc, type HandKind } from "@/components/art/hand";
import { ShakeScene } from "@/components/art/shake-scene";
import { Book, BookCover, NewBookButton } from "@/components/book-cover";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DebtCard } from "@/components/group/debt-card";
import { GuestBanner } from "@/components/guest-banner";
import { EditorDialog } from "@/components/editor-dialog";
import { Amount, RowAmount } from "@/components/money";
import { EmptyState, Notice } from "@/components/notices";
import { CategoryPicker, PeoplePicker, PersonPicker } from "@/components/pickers";
import { Screen, ScreenHeader, Section } from "@/components/screen";
import { CompleteSummary } from "@/components/group/complete-summary";
import { SyncStamp, SyncStatusBadge } from "@/components/sync-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldSet } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { List, ListHeading, ListRow } from "@/components/ui/list";
import { Inline, Stack } from "@/components/ui/stack";
import { CurrentUserProvider } from "@/lib/auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PEOPLE = [
	{ id: "a1", label: "You" },
	{ id: "j2", label: "Jo" },
	{ id: "p3", label: "Priya" },
	{ id: "s4", label: "Sam" },
];
const KINDS: HandKind[] = ["food", "drinks", "stay", "travel", "groceries", "fun", "new"];
const CATEGORIES = [
	{ value: "food", label: "Food", kind: "food" as const },
	{ value: "drinks", label: "Drinks", kind: "drinks" as const },
	{ value: "stay", label: "Stay", kind: "stay" as const },
	{ value: "travel", label: "Travel", kind: "travel" as const },
	{ value: "groceries", label: "Groceries", kind: "groceries" as const },
	{ value: "fun", label: "Fun", kind: "fun" as const },
];
const SWATCHES = [
	["Paper", "bg-paper border border-border"],
	["Ink", "bg-ink"],
	["Raised", "bg-raised border border-border"],
	["Sunken", "bg-sunken"],
	["Owed", "bg-owed"],
	["Owe", "bg-owe-mark"],
	["Settled", "bg-settled"],
	["Waiting", "bg-waiting"],
	["Food", "bg-category-food"],
	["Drinks", "bg-category-drinks"],
	["Stay", "bg-category-stay"],
	["Travel", "bg-category-travel"],
	["Groceries", "bg-category-groceries"],
	["Fun", "bg-category-fun"],
];

// Development only (/kit): every token, primitive and container in one place.
export function KitPage() {
	const [payer, setPayer] = useState("a1");
	const [split, setSplit] = useState(["a1", "j2", "s4"]);
	const [category, setCategory] = useState<string | null>("groceries");
	const [editor, setEditor] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [shakeKey, setShakeKey] = useState(0);

	return (
		<div className="px-page pt-section">
			<Screen width="wide">
				<ScreenHeader
					eyebrow={
						<Inline>
							<HandshakeMark className="h-8 w-12" />
							<span className="type-wordmark text-ink">handshake</span>
						</Inline>
					}
					title="many hands"
					lead="Tokens, primitives and containers."
				/>

				<Section title="Colour">
					<div className="grid grid-cols-4 gap-stack sm:grid-cols-7">
						{SWATCHES.map(([name, cls]) => (
							<span key={name} className="type-caption flex flex-col gap-1">
								<span className={`h-12 rounded-lg ${cls}`} />
								{name}
							</span>
						))}
					</div>
				</Section>

				<Section title="Type">
					<Stack gap="control">
						<span className="type-display">Who owes who, sorted.</span>
						<span className="type-h1">Your groups</span>
						<span className="type-h2">Japan 2027</span>
						<span className="type-h3">New expense</span>
						<span className="type-h4">Two payments square everyone</span>
						<span className="type-body">Split costs with friends and settle up in a tap.</span>
						<span className="type-label text-muted-foreground">Paid by</span>
						<Inline gap="stack">
							<Amount cents={6000} size="lg" tone="owed" />
							<Amount cents={-3000} size="md" tone="owe" />
							<Amount cents={2300} size="sm" />
							<Amount cents={6000} signed tone="owed" />
						</Inline>
					</Stack>
				</Section>

				<Section title="Buttons and badges">
					<Inline>
						<Button>Add expense</Button>
						<Button variant="outline">Settle up</Button>
						<Button variant="secondary">Settle</Button>
						<Button variant="ghost">Later</Button>
						<Button variant="destructive">Delete</Button>
						<Button variant="link" size="inline">
							Have a code?
						</Button>
						<Button size="icon" variant="ghost" aria-label="More">
							<MoreHorizontal />
						</Button>
						<Button size="sm">
							<Plus /> Add person
						</Button>
					</Inline>
					<Inline>
						<Badge>Owner</Badge>
						<Badge tone="waiting">Not synced yet</Badge>
						<Badge tone="owe">Needs resolving</Badge>
						<Badge tone="settled">
							<CheckDoodle /> Settled
						</Badge>
						<Badge tone="owed">Owed</Badge>
						<Badge tone="outline">Not joined yet</Badge>
						<SyncStatusBadge />
					</Inline>
					<Inline gap="stack">
						<SyncStamp state="synced" title="Synced" />
						<SyncStamp state="syncing" title="Syncing" />
						<SyncStamp state="waiting" waiting={2} title="2 waiting" />
						<SyncStamp state="offline" waiting={1} title="Offline, 1 waiting" />
						<SyncStamp state="error" title="Not synced" />
					</Inline>
					<div
						data-kit="header-corner"
						className="flex w-fit items-center gap-control rounded-lg border border-border bg-paper px-panel py-control"
					>
						<Button variant="ghost" size="icon" className="relative rounded-full" aria-label="Nudges, 2 new">
							<BellDoodle ringing className="!size-[1.625rem]" />
							<span className="type-micro absolute -right-0.5 top-0 flex h-5 min-w-5 rotate-6 items-center justify-center rounded-full border-[1.5px] border-ink bg-owe-mark px-1 font-semibold tabular-nums text-paper">
								2
							</span>
						</Button>
						<SyncStamp state="synced" title="Synced" />
						<Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
							<span className="rounded-full ring-[1.5px] ring-ink ring-offset-[1.5px] ring-offset-paper">
								<Face seed="alex" name="" size={34} />
							</span>
						</Button>
					</div>
				</Section>

				<Section title="Guest banner">
					<div data-kit="guest-banner">
						<CurrentUserProvider value={{ id: "kit-guest", email: "", isAnonymous: true }}>
							<GuestBanner />
						</CurrentUserProvider>
					</div>
				</Section>

				<Section title="Debt cards">
					<div data-kit="debt-cards" className="grid gap-stack sm:grid-cols-3">
						<DebtCard
							from={{ id: "j2", name: "Jo" }}
							to={{ id: "a1", name: "You" }}
							amountCents={1834}
							sentence="Jo owes you"
							actions={
								<>
									<Button size="sm" variant="secondary">
										Settle
									</Button>
									<Button size="sm" variant="outline">
										Nudge
									</Button>
								</>
							}
						/>
						<DebtCard
							from={{ id: "a1", name: "You" }}
							to={{ id: "s4", name: "Sam" }}
							amountCents={167}
							tilt="down"
							fromBadge={
								<Badge tone="settled">
									<CheckDoodle /> Paid
								</Badge>
							}
							toBadge={<Badge tone="waiting">Waiting</Badge>}
							sentence="Waiting for Sam"
							actions={
								<Button size="sm" variant="outline">
									Undo
								</Button>
							}
							actionsSide="from"
						/>
						<DebtCard
							from={{ id: "p3", name: "Priya" }}
							to={{ id: "a1", name: "You" }}
							amountCents={1834}
							fromBadge={
								<Badge tone="settled">
									<CheckDoodle /> Paid $10.00
								</Badge>
							}
							sentence="Priya says they paid you"
							actions={
								<>
									<Button size="sm">Confirm</Button>
									<Button size="sm" variant="outline">
										Decline
									</Button>
								</>
							}
						/>
					</div>
				</Section>

				<Section title="The cast">
					<Inline gap="stack">
						{KINDS.map((k) => (
							<Hand key={k} kind={k} size={110} blob label={k} />
						))}
						<Hand kind="shake" size={110} label="Paid back" />
					</Inline>
					<Inline gap="stack">
						{KINDS.map((k) => (
							<HandDisc key={k} kind={k} size={46} />
						))}
						<HandDisc kind="shake" size={46} />
					</Inline>
				</Section>

				<Section title="Friends">
					<Inline gap="stack">
						{["alex", "jo", "priya", "sam", "mo", "kim", "lee"].map((n) => (
							<Face key={n} seed={n} name={n} size={56} />
						))}
					</Inline>
					<FacePile people={PEOPLE.map((p) => ({ id: p.id, name: p.label }))} size={30} />
				</Section>

				<Section title="Covers">
					<div className="grid grid-cols-2 gap-x-stack gap-y-section sm:grid-cols-4">
						<BookCover name="Japan 2027" kind="travel" />
						<BookCover name="Roommates" kind="stay" />
						<BookCover name="Dinner club with a long name" kind="food" />
						<NewBookButton label="Start a group" onClick={() => undefined} />
					</div>
					<div className="max-w-md">
						<Book name="Japan 2027" note="Tokyo and Kyoto, April" kind="travel">
							<Stack gap="control" className="h-full">
								<span className="type-h2">Japan 2027</span>
								<Inline>
									<FacePile people={PEOPLE.map((p) => ({ id: p.id, name: p.label }))} size={30} />
									<span className="type-label text-muted-foreground">4 friends</span>
								</Inline>
								<span className="mt-auto type-label text-muted-foreground">You're owed</span>
								<Amount cents={6000} size="lg" tone="owed" />
							</Stack>
						</Book>
					</div>
				</Section>

				<Section title="Rows">
					<div>
						<ListHeading>Tue 4 Nov</ListHeading>
						<List>
							<ListRow
								leading={<HandDisc kind="travel" size={46} />}
								title="Taxi to Shibuya"
								subtitle="You paid $60.00"
								trailing={<RowAmount label="you lent" cents={4000} tone="owed" />}
							/>
							<ListRow
								leading={<HandDisc kind="shake" size={46} />}
								title="Jo paid Priya $10.00"
								subtitle="Payment"
								trailing={<span className="type-label text-muted-foreground">not involved</span>}
							/>
							<ListRow
								asChild
								leading={<HandDisc kind="groceries" size={46} />}
								title="Groceries at Lawson"
								subtitle={
									<Inline gap="control">
										Priya paid $40.00 <Badge tone="waiting">Not synced yet</Badge>
									</Inline>
								}
								trailing={<RowAmount label="you owe" cents={1000} tone="owe" />}
							>
								<button type="button" />
							</ListRow>
						</List>
					</div>
				</Section>

				<Section title="Pickers">
					<FieldSet legend="Category">
						<CategoryPicker label="Category" options={CATEGORIES} value={category} onChange={setCategory} />
					</FieldSet>
					<FieldSet legend="Paid by">
						<PersonPicker label="Paid by" people={PEOPLE} value={payer} onChange={setPayer} />
					</FieldSet>
					<FieldSet legend="Split between">
						<PeoplePicker label="Split between" people={PEOPLE} value={split} onChange={setSplit} />
					</FieldSet>
				</Section>

				<Section title="Fields">
					<div className="grid gap-section sm:grid-cols-2">
						<Field label="Amount" htmlFor="kit-amount">
							<div className="flex items-baseline gap-0.5">
								<span className="type-stat-xl">$</span>
								<Input id="kit-amount" variant="amount" inputMode="decimal" defaultValue="23.00" />
							</div>
						</Field>
						<Stack>
							<Field label="What for?" htmlFor="kit-what">
								<Input id="kit-what" defaultValue="Groceries at Lawson" />
							</Field>
							<Field label="Email" htmlFor="kit-email" error="That doesn't look like an email.">
								<Input id="kit-email" variant="boxed" aria-invalid defaultValue="alex@" />
							</Field>
							<Field label="Code" htmlFor="kit-code">
								<Input id="kit-code" variant="code" defaultValue="482913" />
							</Field>
							<Field label="Notes" htmlFor="kit-notes" hint="Only the group sees this.">
								<Textarea id="kit-notes" />
							</Field>
							<label className="type-body flex items-center gap-control">
								<Checkbox defaultChecked /> Everyone
							</label>
						</Stack>
					</div>
				</Section>

				<Section title="Cards and notices">
					<div className="grid gap-stack sm:grid-cols-3">
						<Card>
							<Inline gap="control" wrap={false}>
								<Face seed="j2" name="Jo" size={44} />
								<span className="relative h-14 flex-1">
									<SquiggleArrow className="absolute inset-0 size-full" />
									<span className="type-money absolute left-1/2 top-[-4px] -translate-x-1/2 -rotate-3 rounded-md border-[1.5px] border-ink bg-paper px-2.5 py-0.5">
										$50.00
									</span>
								</span>
								<Face seed="a1" name="You" size={44} />
							</Inline>
							<Inline justify="between">
								<span className="type-body-sm font-medium">Jo pays you</span>
								<Button size="sm">Settle</Button>
							</Inline>
						</Card>
						<Card variant="well">
							<Inline justify="between">
								<span>Jo owes</span>
								<Amount cents={767} />
							</Inline>
							<Inline justify="between">
								<span>Your share</span>
								<Amount cents={766} />
							</Inline>
							<span className="type-caption text-muted-foreground">You cover the 1¢ left over from rounding.</span>
						</Card>
						<Card variant="raised">
							<CardHeader>
								<CardTitle>Connected apps</CardTitle>
								<CardDescription>Pholio reads payments that count.</CardDescription>
							</CardHeader>
						</Card>
					</div>
					<Notice
						tone="waiting"
						action={
							<Button size="sm" variant="secondary">
								Add email
							</Button>
						}
					>
						You're a guest. When the group is completed, guests lose access.
					</Notice>
					<EmptyState kind="new" title="No expenses yet." action={<Button>Add expense</Button>} />
				</Section>

				<Section title="Tabs, menus and dialogs">
					<Tabs defaultValue="entries">
						<TabsList>
							<TabsTrigger value="entries">Entries</TabsTrigger>
							<TabsTrigger value="balances">Balances</TabsTrigger>
							<TabsTrigger value="people">People</TabsTrigger>
						</TabsList>
						<TabsContent value="entries" className="pt-stack">
							Entries
						</TabsContent>
						<TabsContent value="balances" className="pt-stack">
							Balances
						</TabsContent>
						<TabsContent value="people" className="pt-stack">
							People
						</TabsContent>
					</Tabs>
					<Inline>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline">Menu</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem>Rename</DropdownMenuItem>
								<DropdownMenuItem>Settle up and complete</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem tone="destructive">
									<Trash2 /> Delete group
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button variant="outline" onClick={() => setEditor(true)}>
							Editor
						</Button>
						<Button variant="outline" onClick={() => setConfirm(true)}>
							Confirm
						</Button>
						<Button variant="outline" onClick={() => setShakeKey((k) => k + 1)}>
							Shake again
						</Button>
					</Inline>
					<EditorDialog
						open={editor}
						onOpenChange={setEditor}
						title="New expense"
						submitLabel="Save expense"
						canSubmit
						onSubmit={() => setEditor(false)}
					>
						<Field label="What for?" htmlFor="kit-editor-what">
							<Input id="kit-editor-what" />
						</Field>
					</EditorDialog>
					<ConfirmDialog
						open={confirm}
						onOpenChange={setConfirm}
						title="Complete Japan 2027?"
						description={<span className="type-body font-semibold text-foreground">8 people still owe $155.02</span>}
						confirmLabel="Complete group"
						onConfirm={() => setConfirm(false)}
					>
						<CompleteSummary
							rows={["Brian", "DAD", "Jo", "Kim", "Lee", "Mo", "Priya", "Ola"].map((n, i) => ({
								key: n,
								fromId: n,
								text: `${n} → ${i % 2 ? "you" : "Sam"}`,
								cents: 1834 + i * 400,
							}))}
							waiting={1}
							guests={["Kim", "Lee"]}
						/>
					</ConfirmDialog>
					<div className="flex flex-col items-center gap-stack rounded-xl bg-primary py-section text-primary-foreground">
						<ShakeScene key={shakeKey} payerTint="hsl(var(--category-groceries))" className="h-40 w-60" />
						<p className="type-h2 animate-rise">Jo paid you $50.00</p>
						<span className="type-h1 animate-sign-off font-bold">Settled</span>
					</div>
					<ReceiptDoodle className="h-20 w-16" />
				</Section>
			</Screen>
		</div>
	);
}
