import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import { EditorDialog } from "@/components/editor-dialog";
import { Amount } from "@/components/money";
import { Notice } from "@/components/notices";
import { CategoryPicker, PeoplePicker, PersonPicker, type PersonOption } from "@/components/pickers";
import { showRefusal } from "@/components/signed-in-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldSet } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Inline, Stack } from "@/components/ui/stack";
import { CATEGORIES } from "@/lib/categories";
import { toLedgerMembers, useCommit, type ExpenseDraft } from "@/lib/changes";
import { useEntry } from "@/lib/entries";
import { useGroup } from "@/lib/groups";
import { newId } from "@/lib/ids";
import { computeShares, validateEntry, type Item, type Share } from "@/lib/ledger";
import { useMembers, useMyMember } from "@/lib/members";
import { parseAmount } from "@/lib/money";
import { allowedWhenCompleted, may } from "@/lib/permissions";
import { billItems, roundingNotes } from "@/lib/settle-view";
import type { Category, EntryRow, MemberRow } from "@/lib/sync/types";
import { byText } from "@/lib/utils";

export type ExpenseEditorProps = {
	groupId: string;
	// Set to edit that bill (editExpense); unset adds a new one (addExpense).
	entryId?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

type ItemDraft = { id: string; description: string; amount: string; paidBy: string; splitAmong: string[] };

type Draft = {
	description: string;
	entryDate: string;
	notes: string;
	category: Category | null;
	items: ItemDraft[];
	// Shown as a list of items (after Add item) rather than one amount.
	itemized: boolean;
};

const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c.id, label: c.label, kind: c.id }));

function today() {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Cents back into what someone would type: 1234 -> "12.34".
function amountText(cents: number) {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function newItem(paidBy: string, splitAmong: string[]): ItemDraft {
	return { id: newId(), description: "", amount: "", paidBy, splitAmong };
}

function initialDraft(entry: EntryRow | null, me: MemberRow, active: MemberRow[]): Draft {
	if (!entry) {
		return {
			description: "",
			entryDate: today(),
			notes: "",
			category: null,
			items: [
				newItem(
					me.id,
					active.map((m) => m.id)
				),
			],
			itemized: false,
		};
	}
	const items = billItems(entry).map((i) => ({
		id: i.id,
		description: i.description ?? "",
		amount: amountText(i.amountCents),
		paidBy: i.paidBy,
		splitAmong: i.splitAmong,
	}));
	return {
		description: entry.description,
		entryDate: entry.entryDate,
		notes: entry.notes ?? "",
		category: entry.category,
		items,
		itemized: items.length > 1 || items[0].description !== "",
	};
}

// The items as the ledger takes them, or null while one is incomplete.
function toItems(draft: Draft): Item[] | null {
	const items: Item[] = [];
	for (const i of draft.items) {
		const cents = parseAmount(i.amount);
		if (cents === null || cents < 1 || !i.paidBy || i.splitAmong.length === 0) return null;
		const description = i.description.trim();
		items.push({
			id: i.id,
			...(description ? { description } : {}),
			amountCents: cents,
			paidBy: i.paidBy,
			splitAmong: i.splitAmong,
		});
	}
	return items;
}

export function ExpenseEditor({ groupId, entryId, open, onOpenChange }: ExpenseEditorProps) {
	const commit = useCommit();
	const group = useGroup(groupId);
	const members = useMembers(groupId, { includeLeft: true });
	const me = useMyMember(groupId);
	const entry = useEntry(entryId ?? "");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);

	const active = useMemo(() => (members ?? []).filter((m) => !m.deletedAt), [members]);
	const ready = group !== undefined && members !== undefined && me !== undefined && (!entryId || entry !== undefined);

	// A fresh draft each time the editor opens.
	useEffect(() => {
		if (open) setDraft(null);
	}, [open]);
	useEffect(() => {
		if (open && ready && draft === null && me) setDraft(initialDraft(entryId ? (entry ?? null) : null, me, active));
	}, [open, ready, draft, me, entry, entryId, active]);

	// Someone who joins or is added while the editor is open joins every split that is still "everyone".
	const activeKey = active.map((m) => m.id).join(",");
	const [everyone, setEveryone] = useState<string[]>([]);
	useEffect(() => {
		const now = activeKey ? activeKey.split(",") : [];
		setDraft((d) => {
			if (!d) return d;
			const was = new Set(everyone);
			const added = now.filter((id) => !was.has(id));
			if (everyone.length === 0 || added.length === 0) return d;
			const all = (ids: string[]) => everyone.every((id) => ids.includes(id));
			return {
				...d,
				items: d.items.map((i) => (all(i.splitAmong) ? { ...i, splitAmong: [...i.splitAmong, ...added] } : i)),
			};
		});
		setEveryone(now);
	}, [activeKey]);

	const items = draft ? toItems(draft) : null;
	const amountCents = items?.reduce((t, i) => t + i.amountCents, 0) ?? 0;
	// The running total counts the items whose amount is already valid.
	const totalCents = (draft?.items ?? []).reduce((t, i) => {
		const cents = parseAmount(i.amount);
		return cents !== null && cents > 0 ? t + cents : t;
	}, 0);
	const shares = items ? computeShares(items) : null;

	const action = entryId ? "entry.update" : "entry.create";
	const blocked = !me
		? "You're not in this group."
		: group?.completedAt && !allowedWhenCompleted(action)
			? "This group is completed."
			: !may(action, me.role)
				? "Guests can't edit bills."
				: entryId && entry?.kind === "payment"
					? "Payments can't be edited."
					: null;

	const valid =
		!!draft &&
		!!items &&
		!!shares &&
		validateEntry(
			{
				kind: "expense",
				description: draft.description,
				amountCents,
				entryDate: draft.entryDate,
				notes: draft.notes.trim() ? draft.notes : null,
				items,
				shares,
			},
			toLedgerMembers(members ?? [])
		).length === 0;

	const save = async () => {
		if (!draft || !items) return;
		const expense: ExpenseDraft = {
			description: draft.description,
			entryDate: draft.entryDate,
			notes: draft.notes.trim() ? draft.notes : null,
			category: draft.category,
			items,
		};
		setSaving(true);
		try {
			const plan = await commit(
				entryId
					? { type: "editExpense", groupId, entryId, draft: expense }
					: { type: "addExpense", groupId, draft: expense }
			);
			if (!plan.ok) showRefusal(plan.code, plan.reason);
			else onOpenChange(false);
		} catch {
			// The layout already said it couldn't save on this device.
		} finally {
			setSaving(false);
		}
	};

	const names = new Map((members ?? []).map((m) => [m.id, m]));
	const label = (id: string) =>
		id === me?.id ? "You" : `${names.get(id)?.displayName ?? "Someone"}${names.get(id)?.deletedAt ? " (left)" : ""}`;

	// Active people, plus anyone who left but is already on this item: you first, then by name.
	const optionsFor = (item: ItemDraft | undefined): PersonOption[] => {
		const ids = new Set(active.map((m) => m.id));
		for (const id of [item?.paidBy, ...(item?.splitAmong ?? [])]) if (id && names.has(id)) ids.add(id);
		const options = [...ids].map((id) => ({ id, label: label(id) })).sort(byText((p) => p.label));
		return [...options.filter((p) => p.id === me?.id), ...options.filter((p) => p.id !== me?.id)];
	};

	const update = (change: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...change } : d));
	const updateItem = (id: string, change: Partial<ItemDraft>) =>
		setDraft((d) => (d ? { ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...change } : i)) } : d));
	// Keep the split in the picker's order: rounding gives odd cents to whoever is listed first.
	const setSplit = (item: ItemDraft, ids: string[]) =>
		updateItem(item.id, {
			splitAmong: optionsFor(item)
				.map((p) => p.id)
				.filter((id) => ids.includes(id)),
		});
	const addItem = () =>
		setDraft((d) => {
			if (!d) return d;
			const payer = d.items[d.items.length - 1]?.paidBy ?? me?.id ?? "";
			return {
				...d,
				itemized: true,
				items: [
					...d.items,
					newItem(
						payer,
						active.map((m) => m.id)
					),
				],
			};
		});
	const removeItem = (id: string) =>
		setDraft((d) => {
			if (!d) return d;
			const rest = d.items.filter((i) => i.id !== id);
			return { ...d, items: rest, itemized: rest.length > 1 };
		});

	const first = draft?.items[0];

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title={entryId ? "Edit expense" : "New expense"}
			submitLabel="Save expense"
			canSubmit={valid && !blocked && !saving}
			onSubmit={save}
		>
			{ready && !me && <Notice>You're not in this group.</Notice>}
			{draft && first && (
				<>
					{blocked && <Notice>{blocked}</Notice>}
					<Stack gap="control">
						{draft.itemized ? (
							<Field label="Total">
								<Amount cents={totalCents} size="xl" />
							</Field>
						) : (
							<Field label="Amount" htmlFor="expense-amount">
								<div className="flex items-baseline gap-0.5">
									<span className="type-stat-xl" aria-hidden>
										$
									</span>
									<Input
										id="expense-amount"
										variant="amount"
										inputMode="decimal"
										autoComplete="off"
										placeholder="0.00"
										value={first.amount}
										onChange={(e) => updateItem(first.id, { amount: e.target.value })}
										aria-invalid={first.amount !== "" && parseAmount(first.amount) === null}
									/>
								</div>
							</Field>
						)}
						<Field label="What for?" htmlFor="expense-what">
							<Input
								id="expense-what"
								maxLength={120}
								autoComplete="off"
								value={draft.description}
								onChange={(e) => update({ description: e.target.value })}
							/>
						</Field>
					</Stack>

					<FieldSet legend="Category">
						<CategoryPicker
							label="Category"
							options={CATEGORY_OPTIONS}
							value={draft.category}
							onChange={(category) => update({ category })}
						/>
					</FieldSet>

					{draft.itemized ? (
						<Stack>
							{draft.items.map((item, n) => (
								<Card key={item.id} className="gap-stack">
									<Inline gap="control" wrap={false}>
										<Input
											aria-label={`Item ${n + 1}`}
											placeholder={`Item ${n + 1}`}
											maxLength={60}
											value={item.description}
											onChange={(e) => updateItem(item.id, { description: e.target.value })}
										/>
										<span className="flex shrink-0 items-baseline gap-0.5 border-b-[1.5px] border-input focus-within:border-ink">
											<span className="type-money" aria-hidden>
												$
											</span>
											<Input
												aria-label={`Item ${n + 1} amount`}
												inputMode="decimal"
												autoComplete="off"
												placeholder="0.00"
												className="type-money w-24 border-0 text-right focus-visible:border-0"
												value={item.amount}
												onChange={(e) => updateItem(item.id, { amount: e.target.value })}
												aria-invalid={item.amount !== "" && parseAmount(item.amount) === null}
											/>
										</span>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Remove item ${n + 1}`}
											onClick={() => removeItem(item.id)}
										>
											<X />
										</Button>
									</Inline>
									<FieldSet legend="Paid by">
										<PersonPicker
											label={`Item ${n + 1} paid by`}
											people={optionsFor(item)}
											value={item.paidBy}
											onChange={(paidBy) => updateItem(item.id, { paidBy })}
										/>
									</FieldSet>
									<FieldSet legend="Split between">
										<PeoplePicker
											label={`Item ${n + 1} split between`}
											people={optionsFor(item)}
											value={item.splitAmong}
											onChange={(ids) => setSplit(item, ids)}
										/>
									</FieldSet>
								</Card>
							))}
						</Stack>
					) : (
						<>
							<FieldSet legend="Paid by">
								<PersonPicker
									label="Paid by"
									people={optionsFor(first)}
									value={first.paidBy}
									onChange={(paidBy) => updateItem(first.id, { paidBy })}
								/>
							</FieldSet>
							<FieldSet legend="Split between">
								<PeoplePicker
									label="Split between"
									people={optionsFor(first)}
									value={first.splitAmong}
									onChange={(ids) => setSplit(first, ids)}
								/>
							</FieldSet>
						</>
					)}

					<div>
						<Button type="button" variant="outline" size="sm" onClick={addItem} disabled={draft.items.length >= 50}>
							<Plus /> Add item
						</Button>
					</div>

					{items && shares && <ResultsWell items={items} shares={shares} me={me?.id ?? null} label={label} />}

					<div className="grid gap-section sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
						<Field label="Date" htmlFor="expense-date">
							<Input
								id="expense-date"
								type="date"
								required
								value={draft.entryDate}
								onChange={(e) => update({ entryDate: e.target.value })}
							/>
						</Field>
						<Field label="Notes" htmlFor="expense-notes">
							<Textarea
								id="expense-notes"
								maxLength={1000}
								className="min-h-11"
								rows={1}
								value={draft.notes}
								onChange={(e) => update({ notes: e.target.value })}
							/>
						</Field>
					</div>
				</>
			)}
		</EditorDialog>
	);
}

// What the bill means for each person: "Jo owes $7.67", "Your share $7.66", and the rounding cent.
function ResultsWell({
	items,
	shares,
	me,
	label,
}: {
	items: Item[];
	shares: Share[];
	me: string | null;
	label: (id: string) => string;
}) {
	const payers = new Set(items.map((i) => i.paidBy));
	const several = payers.size > 1;
	const rows = shares
		.filter((s) => s.paidCents > 0 || s.owedCents > 0)
		.sort((a, b) => Number(a.memberId === me) - Number(b.memberId === me) || byText(label)(a.memberId, b.memberId));
	const possessive = (id: string) => (id === me ? "Your" : `${label(id)}'s`);
	const notes = roundingNotes(items, shares).map((n) => {
		const cents = `${Math.abs(n.cents)}¢`;
		if (n.memberId === n.payerId)
			return n.memberId === me
				? `You cover the ${cents} left over from rounding.`
				: `${label(n.memberId)} covers the ${cents} left over from rounding.`;
		return `${possessive(n.memberId)} share is ${cents} ${n.cents < 0 ? "less" : "more"} from rounding.`;
	});

	return (
		<Card variant="well" className="type-body gap-control" aria-live="polite">
			{rows.map((s) => {
				const isPayer = payers.has(s.memberId);
				return (
					<Inline key={s.memberId} justify="between" wrap={false} className="gap-stack">
						<span className="min-w-0">
							{isPayer
								? `${possessive(s.memberId)} share`
								: s.memberId === me
									? "You owe"
									: `${label(s.memberId)} owes`}
							{isPayer && several && (
								<span className="type-caption block text-muted-foreground">
									paid <Amount cents={s.paidCents} tone="inherit" />
								</span>
							)}
						</span>
						<Amount cents={s.owedCents} />
					</Inline>
				);
			})}
			{notes.map((note) => (
				<span key={note} className="type-caption text-muted-foreground">
					{note}
				</span>
			))}
		</Card>
	);
}
