import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNavigate } from "react-router";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CoverDialog } from "@/components/group/cover-dialog";
import { GroupDetailsDialog } from "@/components/group/group-details-dialog";
import type { GroupData } from "@/components/group/group-data";
import { useRun } from "@/components/group/use-run";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { paymentSides } from "@/lib/changes";

// The group's "…" menu: name and note, cover, settle up and complete, reopen, leave, delete.
export function GroupMenu({ data }: { data: GroupData }) {
	const run = useRun();
	const navigate = useNavigate();
	const [dialog, setDialog] = useState<"details" | "cover" | "leave" | "delete" | null>(null);
	const { group, me } = data;
	if (!group || !me) return null;

	const completed = !!group.completedAt;
	const fullMembers = data.active.filter((m) => m.userId !== null && m.role !== "guest");
	const lastFullMember = me.role !== "guest" && fullMembers.length === 1;
	const nextOwner = fullMembers
		.filter((m) => m.id !== me.id)
		.sort((a, b) => (a.joinedAt ?? "").localeCompare(b.joinedAt ?? "") || a.id.localeCompare(b.id))[0];

	// Leaving undoes your payments still waiting for an answer.
	const pending = data.entries.filter(
		(e) => e.kind === "payment" && e.paymentStatus === "pending" && e.shares.some((sh) => sh.memberId === me.id)
	);
	const pendingLine =
		pending.length === 1
			? `Your payment waiting for ${data.names.inSentence(
					Object.values(paymentSides(pending[0])).find((id) => id !== me.id)
				)} is undone.`
			: pending.length > 1
				? `Your ${pending.length} payments waiting for an answer are undone.`
				: null;

	const mayEdit = data.can("group.rename");
	const mayCover = data.can("group.recolor") || data.can("group.sticker");
	const mayComplete = data.can("group.complete");
	const mayReopen = completed && data.can("group.reopen");
	const mayLeave = data.can("member.remove.self");
	const mayDelete = data.can("group.delete");
	const close = (open: boolean) => !open && setDialog(null);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="icon" variant="ghost" aria-label="More options">
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{mayEdit && <DropdownMenuItem onSelect={() => setDialog("details")}>Edit name and note</DropdownMenuItem>}
					{mayCover && <DropdownMenuItem onSelect={() => setDialog("cover")}>Cover</DropdownMenuItem>}
					{mayComplete && (
						<DropdownMenuItem onSelect={() => navigate(`/groups/${group.id}/settle`)}>
							Settle up and complete
						</DropdownMenuItem>
					)}
					{mayReopen && (
						<DropdownMenuItem onSelect={() => void run({ type: "reopenGroup", groupId: group.id })}>
							Reopen group
						</DropdownMenuItem>
					)}
					{(mayEdit || mayCover || mayComplete || mayReopen) && (mayLeave || mayDelete) && <DropdownMenuSeparator />}
					{mayLeave && <DropdownMenuItem onSelect={() => setDialog("leave")}>Leave group</DropdownMenuItem>}
					{mayDelete && (
						<DropdownMenuItem tone="destructive" onSelect={() => setDialog("delete")}>
							Delete group
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<GroupDetailsDialog group={group} open={dialog === "details"} onOpenChange={close} />
			{mayCover && <CoverDialog data={data} open={dialog === "cover"} onOpenChange={close} />}
			<ConfirmDialog
				open={dialog === "leave"}
				onOpenChange={close}
				title={`Leave ${group.name}?`}
				description={
					<>
						<p>Your bills and debts stay with your name.</p>
						{pendingLine && <p>{pendingLine}</p>}
						{lastFullMember ? (
							<p>You're the last member, so the group is deleted for everyone.</p>
						) : (
							me.role === "owner" && nextOwner && <p>{nextOwner.displayName} becomes the owner.</p>
						)}
					</>
				}
				confirmLabel="Leave group"
				tone="destructive"
				onConfirm={async () => {
					const plan = await run({ type: "removePerson", groupId: group.id, memberId: me.id });
					if (plan.ok) navigate("/");
				}}
			/>
			<ConfirmDialog
				open={dialog === "delete"}
				onOpenChange={close}
				title={`Delete ${group.name}?`}
				description="It disappears for everyone in the group."
				confirmLabel="Delete group"
				tone="destructive"
				onConfirm={async () => {
					const plan = await run({ type: "deleteGroup", groupId: group.id });
					if (plan.ok) navigate("/");
				}}
			/>
		</>
	);
}
