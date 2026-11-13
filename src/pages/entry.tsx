import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { Face } from "@/components/art/face";
import { HandDisc } from "@/components/art/hand";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ExpenseEditor } from "@/components/editors/expense-editor";
import { ShakeConfirmation } from "@/components/editors/shake-confirmation";
import { ConflictResolver } from "@/components/group/conflict-resolver";
import { paymentTitle } from "@/components/group/entry-list-row";
import { useGroupData, type GroupData } from "@/components/group/group-data";
import { PaymentButtons, pendingSentence } from "@/components/group/payment-buttons";
import { todayIso } from "@/components/group/today";
import { EntryNote } from "@/components/group/entry-note";
import { useRun } from "@/components/group/use-run";
import { Amount, RowAmount } from "@/components/money";
import { EmptyState, Notice } from "@/components/notices";
import { Screen, ScreenHeader, Section } from "@/components/screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list";
import { Inline, Stack } from "@/components/ui/stack";
import { paymentSides } from "@/lib/changes";
import { useConflicts, useEntry } from "@/lib/entries";
import { dayLabel, isVisibleTo, joinNames, roundingCents } from "@/lib/group-view";
import { formatAmount } from "@/lib/money";
import type { EntryRow } from "@/lib/sync/types";
import { byText } from "@/lib/utils";

// Each person's part of one item, rounded normally ("$3.33 each").
function eachCents(amountCents: number, people: number) {
	return Math.floor((2 * amountCents + people) / (2 * people));
}

function roundingNote(cents: number | undefined) {
	if (!cents) return null;
	const size = `${Math.abs(cents)}¢`;
	return cents > 0 ? `incl. ${size} rounding` : `${size} less for rounding`;
}

export function EntryPage() {
	const { groupId = "", entryId = "" } = useParams();
	const data = useGroupData(groupId);
	const entry = useEntry(entryId);
	const conflicts = useConflicts(entryId);
	const [editing, setEditing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [resolving, setResolving] = useState(false);
	const [shake, setShake] = useState<string | null>(null);
	const navigate = useNavigate();
	const run = useRun();

	if (data.loading || entry === undefined) return null;
	const { group, me, names } = data;
	const back = { to: `/groups/${groupId}`, label: group?.name ?? "Group" };

	const openConflicts = conflicts ?? [];
	if (
		!group ||
		group.deletedAt ||
		!me ||
		!entry ||
		entry.groupId !== groupId ||
		!isVisibleTo(entry, me.id) ||
		(entry.deletedAt && openConflicts.length === 0)
	) {
		return (
			<Screen>
				<ScreenHeader back={back} />
				<EmptyState
					kind="new"
					title={entry?.deletedAt ? "This bill was deleted." : "This isn't on this device."}
					action={
						<Button asChild variant="outline">
							<Link to={back.to}>Back to {back.label}</Link>
						</Button>
					}
				/>
			</Screen>
		);
	}

	const isPayment = entry.kind === "payment";
	const mine = entry.createdByMemberId === me.id;
	const mayEdit = !isPayment && !entry.deletedAt && data.can("entry.update");
	const mayDelete = !isPayment && !entry.deletedAt && data.can(mine ? "entry.delete.own" : "entry.delete.others");
	const edited = entry.updatedByMemberId !== entry.createdByMemberId || entry.updatedAt !== entry.createdAt;

	return (
		<Screen>
			<ScreenHeader back={back} />

			<header className="flex items-start gap-stack">
				<HandDisc kind={isPayment ? "shake" : (entry.category ?? "new")} size={56} />
				<Stack gap="none" className="min-w-0 flex-1">
					<h1 className="type-h2 break-words">{isPayment ? paymentTitle(entry, names) : entry.description}</h1>
					<span className="type-body-sm text-muted-foreground">{dayLabel(entry.entryDate, todayIso())}</span>
				</Stack>
				{!isPayment && <Amount cents={entry.amountCents} size="md" />}
			</header>

			{(data.unsynced.has(entry.id) || openConflicts.length > 0 || isPayment) && (
				<Inline gap="control">
					{isPayment && <PaymentBadge entry={entry} data={data} />}
					{openConflicts.length > 0 && <Badge tone="owe">Needs resolving</Badge>}
					{data.unsynced.has(entry.id) && <Badge tone="waiting">Not synced yet</Badge>}
				</Inline>
			)}

			{openConflicts.length > 0 &&
				(data.can("conflict.resolve") ? (
					<Notice
						tone="waiting"
						action={
							<Button size="sm" onClick={() => setResolving(true)}>
								Resolve
							</Button>
						}
					>
						Changed by two people at the same time.
					</Notice>
				) : (
					<Notice tone="waiting">Waiting for a member to resolve this.</Notice>
				))}

			{isPayment ? (
				<PaymentDetail entry={entry} data={data} onConfirmed={setShake} />
			) : (
				<BillDetail entry={entry} data={data} />
			)}

			{isPayment ? (
				entry.notes && <p className="type-hand-lg whitespace-pre-wrap break-words">{entry.notes}</p>
			) : (
				<EntryNote key={entry.id} entry={entry} mayEdit={mayEdit} />
			)}

			<p className="type-label text-muted-foreground">
				{isPayment ? "Recorded" : "Added"} by {names.inSentence(entry.createdByMemberId)}
				{edited && !isPayment && ` · Edited by ${names.inSentence(entry.updatedByMemberId)}`}
			</p>

			{(mayEdit || mayDelete) && (
				<Inline gap="stack">
					{mayEdit && (
						<Button variant="outline" onClick={() => setEditing(true)}>
							Edit
						</Button>
					)}
					{mayDelete && (
						<Button variant="ghost" className="text-destructive" onClick={() => setDeleting(true)}>
							Delete
						</Button>
					)}
				</Inline>
			)}

			{mayEdit && <ExpenseEditor groupId={groupId} entryId={entry.id} open={editing} onOpenChange={setEditing} />}
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${entry.description}?`}
				description="It comes off everyone's balances."
				confirmLabel="Delete"
				tone="destructive"
				onConfirm={async () => {
					const plan = await run({ type: "deleteEntry", groupId, entryId: entry.id });
					if (plan.ok) navigate(back.to);
				}}
			/>
			{resolving && <ConflictResolver data={data} entryId={entry.id} open onOpenChange={setResolving} />}
			<ShakeConfirmation groupId={groupId} entryId={shake} onClose={() => setShake(null)} />
		</Screen>
	);
}

function PaymentBadge({ entry, data }: { entry: EntryRow; data: GroupData }) {
	switch (entry.paymentStatus) {
		case "pending":
			return <Badge tone="waiting">{pendingSentence(entry, data.names, data.me?.id)}</Badge>;
		case "declined":
			return <Badge tone="owe">Declined</Badge>;
		case "undone":
			return <Badge tone="outline">Undone</Badge>;
		default:
			return <Badge tone="settled">Confirmed</Badge>;
	}
}

function PaymentDetail({
	entry,
	data,
	onConfirmed,
}: {
	entry: EntryRow;
	data: GroupData;
	onConfirmed: (entryId: string) => void;
}) {
	const { from, to } = paymentSides(entry);
	const { names } = data;
	const people = [from, to].filter((id): id is string => !!id);
	return (
		<>
			<List>
				{people.map((id) => (
					<ListRow
						key={id}
						leading={<Face seed={id} name={names.of(id)} size={36} />}
						title={names.of(id)}
						subtitle={id === from ? "Paid" : "Received"}
						trailing={<Amount cents={entry.amountCents} />}
					/>
				))}
			</List>
			{entry.paymentStatus === "declined" && entry.closeNote && (
				<Notice>
					{names.of(entry.payerConfirmedAt ? to : from)} said: “{entry.closeNote}”
				</Notice>
			)}
			{entry.paymentStatus === "pending" && (
				<Inline gap="control">
					<PaymentButtons entry={entry} data={data} onConfirmed={onConfirmed} size="default" />
				</Inline>
			)}
			{entry.paymentStatus !== "confirmed" && (
				<p className="type-label text-muted-foreground">Only {joinNames(people.map(names.inSentence))} see this.</p>
			)}
		</>
	);
}

function BillDetail({ entry, data }: { entry: EntryRow; data: GroupData }) {
	const { names } = data;
	const items = entry.items ?? [];
	const rounding = roundingCents(items, entry.shares);
	const shares = [...entry.shares].sort(byText((s) => names.of(s.memberId)));

	return (
		<>
			<Section title={items.length === 1 ? "Item" : "Items"}>
				<List>
					{items.map((item, i) => (
						<ListRow
							key={item.id}
							title={item.description || (items.length === 1 ? entry.description : `Item ${i + 1}`)}
							subtitle={`${names.of(item.paidBy)} paid · ${joinNames(
								item.splitAmong.map(names.inSentence).sort((a, b) => a.localeCompare(b))
							)}`}
							trailing={
								<RowAmount
									label={`${formatAmount(eachCents(item.amountCents, item.splitAmong.length))} each`}
									cents={item.amountCents}
									tone="neutral"
								/>
							}
						/>
					))}
				</List>
			</Section>

			<Section title="Who paid, who owes">
				<List>
					{shares.map((share) => {
						const note = roundingNote(rounding.get(share.memberId));
						return (
							<ListRow
								key={share.memberId}
								leading={<Face seed={share.memberId} name={names.of(share.memberId)} size={36} />}
								title={names.of(share.memberId)}
								subtitle={
									[share.paidCents > 0 ? `paid ${formatAmount(share.paidCents)}` : null, note]
										.filter(Boolean)
										.join(" · ") || undefined
								}
								trailing={<RowAmount label="share" cents={share.owedCents} tone="neutral" />}
							/>
						);
					})}
				</List>
			</Section>
		</>
	);
}
