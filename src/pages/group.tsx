import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { CheckDoodle } from "@/components/art/doodles";
import { Book } from "@/components/book-cover";
import { ExpenseEditor } from "@/components/editors/expense-editor";
import { BalancesTab } from "@/components/group/balances-tab";
import { ConflictPopup } from "@/components/group/conflict-popup";
import { ConflictResolver } from "@/components/group/conflict-resolver";
import { EntriesTab } from "@/components/group/entries-tab";
import { useGroupData } from "@/components/group/group-data";
import { GroupMenu } from "@/components/group/group-menu";
import { LedgerPage } from "@/components/group/ledger-page";
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

export function GroupPage() {
	const { groupId = "" } = useParams();
	const data = useGroupData(groupId);
	const [adding, setAdding] = useState(false);
	const [resolving, setResolving] = useState<string | null>(null);
	const [search, setSearch] = useSearchParams();
	const tab = TABS.find((t) => t === search.get("tab")) ?? "entries";
	const { group, me, names } = data;

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
	const balance = data.summary?.people.find((p) => p.memberId === me.id)?.balanceCents ?? 0;
	const kind = data.category ?? "new";
	const unsynced = data.unsynced.has(group.id);
	const openConflicts = data.conflicts.length;
	const mayAdd = data.can("entry.create");

	const aside = (
		<>
			<Book name={group.name} note={group.note} kind={kind}>
				<LedgerPage
					name={group.name}
					kind={kind}
					people={data.active.map((m) => ({ id: m.id, name: m.displayName }))}
					balanceCents={balance}
				/>
			</Book>
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
