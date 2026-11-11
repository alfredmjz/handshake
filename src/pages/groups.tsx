import { useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { X } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { CheckDoodle } from "@/components/art/doodles";
import { BookCover, NewBookButton } from "@/components/book-cover";
import { EditorDialog } from "@/components/editor-dialog";
import { JoinCodeForm } from "@/components/join-code-form";
import { Amount } from "@/components/money";
import { useMyBalances, type GroupStanding } from "@/components/my-balances";
import { EmptyState, Notice } from "@/components/notices";
import { Screen, ScreenHeader, Section } from "@/components/screen";
import { showRefusal } from "@/components/signed-in-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Stack } from "@/components/ui/stack";
import { defaultDisplayName, useCurrentUser } from "@/lib/auth";
import { useCommit } from "@/lib/changes";
import { dismissMovedAwayNotice, useMovedAwayNotices } from "@/lib/codes";
import { useGroupCategories } from "@/lib/entries";
import { useGroups } from "@/lib/groups";
import { overallOf } from "@/lib/shell-view";
import type { Category, GroupRow } from "@/lib/sync/types";

const GRID = "grid grid-cols-2 gap-x-stack gap-y-section sm:grid-cols-3 lg:grid-cols-5";

function Standing({ standing }: { standing: GroupStanding | undefined }) {
	if (!standing) return <Skeleton className="h-12 w-24" />;
	const { balanceCents, others } = standing;
	if (balanceCents === 0)
		return (
			<span className="flex flex-col gap-0.5">
				<span className="type-money-lg flex items-center gap-1.5">
					<CheckDoodle className="size-5" />
					Settled
				</span>
				<span className="type-caption text-muted-foreground">
					{others === 0 ? "Just you so far" : `${others} ${others === 1 ? "friend" : "friends"}, all square`}
				</span>
			</span>
		);
	return (
		<span className="flex flex-col gap-0.5">
			<Amount cents={balanceCents} size="md" tone={balanceCents > 0 ? "owed" : "owe"} />
			<span className="type-caption text-muted-foreground">{balanceCents > 0 ? "owed to you" : "you owe"}</span>
		</span>
	);
}

function GroupCell({
	group,
	kind,
	standing,
}: {
	group: GroupRow;
	kind: Category | null | undefined;
	standing: GroupStanding | undefined;
}) {
	const to = `/groups/${group.id}`;
	const navigate = useNavigate();
	// Only the cover being opened carries the shared name, so it alone lifts off the shelf into the notebook.
	const [lifting, setLifting] = useState(false);

	function open(e: MouseEvent<HTMLAnchorElement>) {
		const plainClick = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
		if (!plainClick || !document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		e.preventDefault();
		flushSync(() => setLifting(true));
		document.startViewTransition(() => flushSync(() => navigate(to, { state: { fromShelf: true } })));
	}

	return (
		<Link
			to={to}
			state={{ fromShelf: true }}
			onClick={open}
			className="flex flex-col gap-control rounded-book outline-none transition-transform duration-quick ease-spring focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
		>
			<BookCover
				name={group.name}
				note={group.note}
				kind={kind ?? "new"}
				style={lifting ? { viewTransitionName: `book-${group.id}` } : undefined}
			/>
			<Standing standing={standing} />
			{group.rowVersion === 0 && (
				<Badge tone="waiting" className="self-start">
					Not synced yet
				</Badge>
			)}
		</Link>
	);
}

function GroupCodeBox() {
	const [open, setOpen] = useState(false);
	if (!open)
		return (
			<Button variant="link" size="inline" className="self-center" onClick={() => setOpen(true)}>
				Have a code?
			</Button>
		);
	return <JoinCodeForm className="mx-auto w-full max-w-md" autoFocus />;
}

// "Sam is now signed in on another device": once for each group this device lost that way.
function MovedAwayNotices() {
	const notices = useMovedAwayNotices();
	if (notices.length === 0) return null;
	return (
		<Stack gap="control">
			{notices.map((n) => (
				<Notice
					key={n.groupId}
					action={
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Dismiss"
							title="Dismiss"
							onClick={() => void dismissMovedAwayNotice(n.groupId)}
						>
							<X />
						</Button>
					}
				>
					<span className="font-semibold">{n.groupName}</span> · {n.displayName} is now signed in on another device
				</Notice>
			))}
		</Stack>
	);
}

function NewGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const user = useCurrentUser();
	const commit = useCommit();
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [note, setNote] = useState("");

	async function create() {
		const plan = await commit({
			type: "createGroup",
			name: name.trim(),
			displayName: defaultDisplayName(user.email),
			note: note.trim() || undefined,
		});
		if (!plan.ok) return showRefusal(plan.code, plan.reason);
		onOpenChange(false);
		setName("");
		setNote("");
		navigate(`/groups/${plan.createdId}`);
	}

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Start a group"
			submitLabel="Create group"
			canSubmit={name.trim().length > 0}
			onSubmit={create}
		>
			<Field label="Name" htmlFor="group-name">
				<Input
					id="group-name"
					placeholder="Japan 2027"
					maxLength={80}
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</Field>
			<Field label="Note (optional)" htmlFor="group-note">
				<Input
					id="group-note"
					placeholder="Flights, ryokan, ramen"
					maxLength={120}
					value={note}
					onChange={(e) => setNote(e.target.value)}
				/>
			</Field>
		</EditorDialog>
	);
}

export function GroupsPage() {
	const user = useCurrentUser();
	const groups = useGroups();
	const balances = useMyBalances();
	const categories = useGroupCategories();
	const [creating, setCreating] = useState(false);

	const open = groups?.filter((g) => !g.completedAt) ?? [];
	const completed = groups?.filter((g) => g.completedAt) ?? [];
	const canCreate = !user.isAnonymous;
	const overall =
		balances && open.length > 0 ? overallOf(open.map((g) => balances.get(g.id)?.balanceCents ?? 0)) : null;

	const cell = (g: GroupRow) => (
		<GroupCell key={g.id} group={g} kind={categories?.get(g.id)} standing={balances?.get(g.id)} />
	);

	return (
		<Screen width="wide">
			<ScreenHeader
				eyebrow={user.isAnonymous ? "Hi there" : `Hi ${defaultDisplayName(user.email)}`}
				title="Your groups"
				lead={
					overall &&
					(overall.standing === "owed" ? (
						<>
							Friends owe you <Amount cents={overall.cents} tone="owed" className="font-semibold" /> overall
						</>
					) : overall.standing === "owe" ? (
						<>
							You owe friends <Amount cents={overall.cents} tone="owe" className="font-semibold" /> overall
						</>
					) : (
						"All square overall"
					))
				}
			/>
			<MovedAwayNotices />

			{groups === undefined ? (
				<div className={GRID}>
					<Skeleton className="aspect-[5/6] w-full" />
					<Skeleton className="aspect-[5/6] w-full" />
				</div>
			) : groups.length === 0 ? (
				<EmptyState
					title={
						canCreate
							? "No groups yet. Start one for a trip, a home or a night out."
							: "No groups yet. Open a group code to join one."
					}
					action={canCreate ? <Button onClick={() => setCreating(true)}>Start a group</Button> : undefined}
				/>
			) : (
				<>
					<div className={GRID}>
						{open.map(cell)}
						{canCreate && <NewBookButton label="Start a group" onClick={() => setCreating(true)} />}
					</div>
					{completed.length > 0 && (
						<Section title="Completed">
							<div className={GRID}>{completed.map(cell)}</div>
						</Section>
					)}
				</>
			)}

			<GroupCodeBox />
			{canCreate && <NewGroupDialog open={creating} onOpenChange={setCreating} />}
		</Screen>
	);
}
