import { useEffect, useMemo, useState, type ReactNode } from "react";

import { EditorDialog } from "@/components/editor-dialog";
import type { GroupData, Names } from "@/components/group/group-data";
import { todayIso } from "@/components/group/today";
import { useRun } from "@/components/group/use-run";
import { Amount } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Inline, Stack } from "@/components/ui/stack";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CATEGORIES } from "@/lib/categories";
import { useConflicts, useEntry } from "@/lib/entries";
import {
	billVersionOf,
	conflictFields,
	defaultChoices,
	dayLabel,
	joinNames,
	mergeVersions,
	resolutionOf,
	type BillVersion,
	type Side,
} from "@/lib/group-view";
import { computeShares } from "@/lib/ledger";
import type { ConflictRow, EntryRow, Item } from "@/lib/sync/types";
import { cn } from "@/lib/utils";

// "Alex's", "Yours".
function whose(name: string) {
	return name === "You" ? "Yours" : `${name}'s`;
}

// The label mid-sentence: "Use all of Alex's", "Keep yours", "Restore this version".
function mid(label: string) {
	return label === "Yours" || label.startsWith("Th") ? label.toLowerCase() : label;
}

// "Dinner was changed by Alex and Sam at the same time" (or deleted by one of them).
export function conflictSentence(entry: EntryRow, conflict: ConflictRow, names: Names): string {
	const current = names.of(entry.updatedByMemberId);
	const proposed = names.of(conflict.proposedByMemberId);
	if (!conflict.proposed)
		return `${proposed} deleted ${entry.description} while ${names.inSentence(entry.updatedByMemberId)} changed it`;
	if (entry.deletedAt)
		return `${proposed} changed ${entry.description} after ${names.inSentence(entry.updatedByMemberId)} deleted it`;
	const who =
		current === proposed
			? names.inSentence(entry.updatedByMemberId)
			: joinNames([names.inSentence(entry.updatedByMemberId), names.inSentence(conflict.proposedByMemberId)]);
	return `${entry.description} was changed by ${who} at the same time`;
}

const FIELD_LABEL: Record<string, string> = {
	description: "What for",
	entryDate: "Date",
	notes: "Notes",
	category: "Category",
};

function fieldLabel(key: string) {
	return FIELD_LABEL[key] ?? `Item ${Number(key.slice(5)) + 1}`;
}

function itemText(item: Item | undefined, names: Names): ReactNode {
	if (!item) return <span className="text-muted-foreground">Not on this version</span>;
	return (
		<span className="flex flex-col gap-0.5">
			<span>
				{item.description ? `${item.description} · ` : ""}
				<Amount cents={item.amountCents} />
			</span>
			<span className="type-label text-muted-foreground">
				{names.of(item.paidBy)} paid · {joinNames(item.splitAmong.map(names.inSentence).sort())}
			</span>
		</span>
	);
}

function fieldValue(key: string, version: BillVersion, names: Names): ReactNode {
	switch (key) {
		case "description":
			return version.description;
		case "entryDate":
			return dayLabel(version.entryDate, todayIso());
		case "notes":
			return version.notes || <span className="text-muted-foreground">No notes</span>;
		case "category":
			return (
				CATEGORIES.find((c) => c.id === version.category)?.label ?? <span className="text-muted-foreground">None</span>
			);
		default:
			return itemText(version.items[Number(key.slice(5))], names);
	}
}

// One version's value for a field: tap to use it.
function Choice({
	selected,
	onSelect,
	label,
	hiddenOnPhone,
	children,
}: {
	selected: boolean;
	onSelect: () => void;
	label: string;
	hiddenOnPhone: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			aria-label={label}
			onClick={onSelect}
			className={cn(
				"type-body-sm flex min-h-tap min-w-0 flex-col items-start gap-1 rounded-lg border-[1.5px] px-panel py-row text-left transition-colors",
				selected ? "border-primary bg-primary/[0.08]" : "border-dashed border-ink/30 hover:border-ink/60",
				hiddenOnPhone && "hidden sm:flex"
			)}
		>
			{children}
		</button>
	);
}

// The split a resolution would save, per person.
function SplitPreview({ items, names }: { items: Item[]; names: Names }) {
	let shares;
	try {
		shares = computeShares(items);
	} catch {
		return <p className="type-body-sm text-owe">Pick at least one item.</p>;
	}
	return (
		<Card variant="well">
			{[...shares]
				.sort((a, b) => names.of(a.memberId).localeCompare(names.of(b.memberId)))
				.map((s) => (
					<Inline key={s.memberId} justify="between" wrap={false}>
						<span className="type-body-sm truncate">{names.of(s.memberId)}</span>
						<span className="type-label text-right text-muted-foreground">
							{s.paidCents > 0 && (
								<>
									paid <Amount cents={s.paidCents} />,{" "}
								</>
							)}
							owes <Amount cents={s.owedCents} />
						</span>
					</Inline>
				))}
		</Card>
	);
}

type ConflictResolverProps = {
	data: GroupData;
	entryId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

// The two versions side by side (one at a time on phones, with a toggle), changed fields marked, a
// choice per field, and the split the choice gives. Works through an entry's conflicts oldest first.
export function ConflictResolver({ data, entryId, open, onOpenChange }: ConflictResolverProps) {
	const run = useRun();
	const entry = useEntry(entryId);
	const conflicts = useConflicts(entryId);
	const conflict = conflicts?.[0];
	const [choices, setChoices] = useState<Record<string, Side>>({});
	const [view, setView] = useState<Side>("current");
	const [deleteChoice, setDeleteChoice] = useState<Side>("current");

	useEffect(() => {
		const base = conflict?.base ? billVersionOf(conflict.base) : null;
		setChoices(
			entry && conflict?.proposed ? defaultChoices(base, billVersionOf(entry), billVersionOf(conflict.proposed)) : {}
		);
		setView("current");
		setDeleteChoice("current");
		// Only when a new conflict comes up; later changes to the entry keep the person's choices.
	}, [conflict?.id, !!entry]);

	// Closes itself once the last conflict on the entry is resolved.
	useEffect(() => {
		if (open && conflicts && conflicts.length === 0) onOpenChange(false);
	}, [open, conflicts, onOpenChange]);

	const current = useMemo(() => (entry ? billVersionOf(entry) : null), [entry]);
	const proposed = useMemo(() => (conflict?.proposed ? billVersionOf(conflict.proposed) : null), [conflict]);
	const fields = useMemo(() => (current && proposed ? conflictFields(current, proposed) : []), [current, proposed]);

	if (!entry || !conflict || !current) return null;

	const { names } = data;
	const currentName = whose(names.of(entry.updatedByMemberId));
	const proposedName = whose(names.of(conflict.proposedByMemberId));
	const [leftLabel, rightLabel] =
		currentName === proposedName ? ["This version", "The other version"] : [currentName, proposedName];
	const groupId = entry.groupId;
	const isDeleteCase = !proposed || !!entry.deletedAt;

	if (isDeleteCase) {
		// One side deleted the bill: keep it deleted, or keep (restore) the version that was edited.
		const deletedNow = !!entry.deletedAt;
		const edited = deletedNow ? proposed : current;
		const keepLabel = deletedNow ? "Keep it deleted" : `Keep ${mid(leftLabel)}`;
		const otherLabel = deletedNow ? `Restore ${mid(rightLabel)}` : "Delete it";
		return (
			<EditorDialog
				open={open}
				onOpenChange={onOpenChange}
				title="Resolve"
				description={conflictSentence(entry, conflict, names)}
				submitLabel="Save"
				canSubmit
				onSubmit={async () => {
					const takeProposed = deleteChoice === "proposed";
					const keepsDeleted = deletedNow ? !takeProposed : takeProposed;
					await run({
						type: "resolveConflict",
						groupId,
						conflictId: conflict.id,
						resolution: takeProposed ? "took_proposed" : "kept_current",
						final: keepsDeleted || !edited ? "deleted" : mergeVersions(edited, edited, {}),
					});
				}}
			>
				<ToggleGroup
					type="single"
					value={deleteChoice}
					onValueChange={(v) => v && setDeleteChoice(v as Side)}
					aria-label="What to keep"
				>
					<ToggleGroupItem value="current" className="pl-3">
						{keepLabel}
					</ToggleGroupItem>
					<ToggleGroupItem value="proposed" className="pl-3">
						{otherLabel}
					</ToggleGroupItem>
				</ToggleGroup>
				{edited && (
					<Card variant="outline">
						{(["description", "entryDate", "notes", "category"] as const).map((key) => (
							<Stack key={key} gap="none">
								<span className="type-label text-muted-foreground">{fieldLabel(key)}</span>
								<span className="type-body-sm">{fieldValue(key, edited, names)}</span>
							</Stack>
						))}
						{edited.items.map((item, i) => (
							<Stack key={item.id} gap="none">
								<span className="type-label text-muted-foreground">{fieldLabel(`item:${i}`)}</span>
								<span className="type-body-sm">{itemText(item, names)}</span>
							</Stack>
						))}
					</Card>
				)}
			</EditorDialog>
		);
	}

	const merged = mergeVersions(current, proposed!, choices);
	const resolution = resolutionOf(fields, choices);
	const useAll = (side: Side) => setChoices(Object.fromEntries(fields.map((f) => [f.key, side])));
	const allFrom = (side: Side) => fields.filter((f) => f.changed).every((f) => (choices[f.key] ?? "current") === side);

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Resolve"
			description={conflictSentence(entry, conflict, names)}
			submitLabel="Save this version"
			canSubmit={merged.items.length > 0}
			onSubmit={async () => {
				await run({ type: "resolveConflict", groupId, conflictId: conflict.id, resolution, final: merged });
			}}
		>
			<Inline gap="control">
				<Button size="sm" variant={allFrom("current") ? "outline" : "secondary"} onClick={() => useAll("current")}>
					Use all of {mid(leftLabel)}
				</Button>
				<Button size="sm" variant={allFrom("proposed") ? "outline" : "secondary"} onClick={() => useAll("proposed")}>
					Use all of {mid(rightLabel)}
				</Button>
			</Inline>

			<ToggleGroup
				type="single"
				value={view}
				onValueChange={(v) => v && setView(v as Side)}
				className="sm:hidden"
				aria-label="Version to show"
			>
				<ToggleGroupItem value="current" className="pl-3">
					{leftLabel}
				</ToggleGroupItem>
				<ToggleGroupItem value="proposed" className="pl-3">
					{rightLabel}
				</ToggleGroupItem>
			</ToggleGroup>

			<div className="hidden grid-cols-2 gap-control sm:grid">
				<span className="type-label font-semibold">{leftLabel}</span>
				<span className="type-label font-semibold">{rightLabel}</span>
			</div>

			<Stack gap="stack">
				{fields.map((field) => {
					const chosen = choices[field.key] ?? "current";
					return (
						<Stack key={field.key} gap="control">
							<Inline gap="control">
								<span className="type-label text-muted-foreground">{fieldLabel(field.key)}</span>
								{field.changed && <Badge tone="waiting">Changed</Badge>}
							</Inline>
							{field.changed ? (
								<div className="grid gap-control sm:grid-cols-2">
									{(["current", "proposed"] as const).map((side) => (
										<Choice
											key={side}
											selected={chosen === side}
											onSelect={() => setChoices((c) => ({ ...c, [field.key]: side }))}
											label={`${fieldLabel(field.key)}: use ${mid(side === "current" ? leftLabel : rightLabel)}`}
											hiddenOnPhone={view !== side}
										>
											{fieldValue(field.key, side === "current" ? current : proposed!, names)}
											{chosen === side && <span className="type-caption text-owed">Using this</span>}
										</Choice>
									))}
								</div>
							) : (
								<span className="type-body-sm">{fieldValue(field.key, current, names)}</span>
							)}
						</Stack>
					);
				})}
			</Stack>

			<Stack gap="control">
				<span className="type-label text-muted-foreground">
					The split · <Amount cents={merged.items.reduce((t, i) => t + i.amountCents, 0)} />
				</span>
				<SplitPreview items={merged.items} names={names} />
			</Stack>
			{conflicts && conflicts.length > 1 && (
				<p className="type-label text-muted-foreground">{conflicts.length - 1} more to resolve after this one.</p>
			)}
		</EditorDialog>
	);
}
