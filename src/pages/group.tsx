import { useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";

import { CheckDoodle } from "@/components/art/doodles";
import { ExpenseEditor } from "@/components/editors/expense-editor";
import { BalancesTab } from "@/components/group/balances-tab";
import { ConflictPopup } from "@/components/group/conflict-popup";
import { ConflictResolver } from "@/components/group/conflict-resolver";
import { EntriesTab } from "@/components/group/entries-tab";
import { useGroupData, type GroupData } from "@/components/group/group-data";
import { GroupMenu } from "@/components/group/group-menu";
import { GroupReceipt, type ReceiptBill } from "@/components/group/group-receipt";
import { PeopleTab } from "@/components/group/people-tab";
import { todayIso } from "@/components/group/today";
import { GuestCodeSheet } from "@/components/guest-code-sheet";
import { EmptyState, Notice } from "@/components/notices";
import { Screen, ScreenColumns, ScreenHeader } from "@/components/screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Inline } from "@/components/ui/stack";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { shortDate } from "@/lib/group-view";

// ?tab=balances opens a tab directly (the nudge bell links there).
const TABS = ["entries", "balances", "people"] as const;

// The group's bills for its receipt, oldest first, and what they cost in all and you in particular.
function receiptOf(data: GroupData) {
	const bills = data.entries.filter((e) => e.kind === "expense").reverse();
	const me = data.me?.id;
	return {
		bills: bills.map((e): ReceiptBill => ({
			id: e.id,
			description: e.description,
			amountCents: e.amountCents,
			// One amount needs no breakdown; a bill of several items lists each under it.
			items:
				e.items && e.items.length > 1
					? e.items.map((item, n) => ({
							id: item.id,
							description: item.description?.trim() || `Item ${n + 1}`,
							amountCents: item.amountCents,
						}))
					: [],
			href: `/groups/${e.groupId}/entries/${e.id}`,
		})),
		totalCents: bills.reduce((sum, e) => sum + e.amountCents, 0),
		myShareCents: bills.reduce((sum, e) => sum + (e.shares.find((s) => s.memberId === me)?.owedCents ?? 0), 0),
	};
}

export function GroupPage() {
	const { groupId = "" } = useParams();
	const data = useGroupData(groupId);
	const [adding, setAdding] = useState(false);
	const [resolving, setResolving] = useState<string | null>(null);
	const [search, setSearch] = useSearchParams();
	const tab = TABS.find((t) => t === search.get("tab")) ?? "entries";
	const { group, me, names } = data;
	// Opened from the shelf: the receipt prints on the way in. A reload or a deep link lands on it printed.
	const fromShelf = (useLocation().state as { fromShelf?: boolean } | null)?.fromShelf === true;

	if (data.loading) return null;

	if (!group || group.deletedAt || !me) {
		return (
			<Screen>
				<EmptyState
					kind="new"
					title="This group isn't on this device."
					action={
						<Button asChild variant="outline">
							<Link to="/">Back to groups</Link>
						</Button>
					}
				/>
			</Screen>
		);
	}

	const completed = !!group.completedAt;
	const kind = data.category ?? "new";
	const unsynced = data.unsynced.has(group.id);
	const openConflicts = data.conflicts.length;
	const mayAdd = data.can("entry.create");

	const aside = (
		<>
			<GroupReceipt
				name={group.name}
				note={group.note}
				kind={kind}
				{...receiptOf(data)}
				entriesHref={`/groups/${group.id}?tab=entries`}
				printing={fromShelf}
			/>
			{(unsynced || openConflicts > 0) && (
				<Inline gap="control">
					{openConflicts > 0 && <Badge tone="owe">Needs resolving</Badge>}
					{unsynced && <Badge tone="waiting">Not synced yet</Badge>}
				</Inline>
			)}
			{completed ? (
				<Notice icon={<CheckDoodle />}>
					Completed on {shortDate(group.completedAt!, todayIso())}
					{group.completedByMemberId && ` by ${names.inSentence(group.completedByMemberId)}`}
				</Notice>
			) : (
				<Inline gap="stack" wrap={false}>
					{mayAdd && (
						<Button className="flex-1" onClick={() => setAdding(true)}>
							Add expense
						</Button>
					)}
					<Button asChild variant="outline" className="flex-1">
						<Link to={`/groups/${group.id}/settle`}>Settle up</Link>
					</Button>
				</Inline>
			)}
		</>
	);

	return (
		<Screen width="wide">
			<ScreenHeader
				back={{ to: "/", label: "Groups" }}
				actions={<GroupMenu data={data} />}
				className="-mb-stack lg:mb-0"
			/>
			<ScreenColumns aside={aside}>
				<Tabs value={tab} onValueChange={(value) => setSearch({ tab: value }, { replace: true })}>
					<TabsList>
						<TabsTrigger value="entries">Entries</TabsTrigger>
						<TabsTrigger value="balances">Balances</TabsTrigger>
						<TabsTrigger value="people">People</TabsTrigger>
					</TabsList>
					<TabsContent value="entries" className="pt-control">
						<EntriesTab data={data} />
					</TabsContent>
					<TabsContent value="balances" className="pt-stack">
						<BalancesTab data={data} />
					</TabsContent>
					<TabsContent value="people" className="pt-control">
						<PeopleTab data={data} />
					</TabsContent>
				</Tabs>
			</ScreenColumns>

			<ExpenseEditor groupId={group.id} open={adding} onOpenChange={setAdding} />
			<ConflictPopup data={data} onResolve={setResolving} />
			<GuestCodeSheet groupId={group.id} />
			{resolving && (
				<ConflictResolver data={data} entryId={resolving} open onOpenChange={(open) => !open && setResolving(null)} />
			)}
		</Screen>
	);
}
