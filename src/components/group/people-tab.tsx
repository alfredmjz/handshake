import { useState } from "react";
import { Copy, Link2, MoreHorizontal, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Face } from "@/components/art/face";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { GroupData } from "@/components/group/group-data";
import { NameDialog } from "@/components/group/name-dialog";
import { todayIso } from "@/components/group/today";
import { useRun } from "@/components/group/use-run";
import { Section } from "@/components/screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { List, ListRow } from "@/components/ui/list";
import { Inline, Stack } from "@/components/ui/stack";
import { shortDate } from "@/lib/group-view";
import { useInvites, useInviteToken } from "@/lib/invites";
import type { InviteRow, MemberRow } from "@/lib/sync/types";

export function inviteUrl(token: string): string {
	return `${location.origin}/join/${token}`;
}

async function copyLink(url: string) {
	try {
		await navigator.clipboard.writeText(url);
		toast.success("Link copied");
	} catch {
		toast.error("Couldn't copy the link");
	}
}

type Dialog =
	| { kind: "add" }
	| { kind: "rename"; member: MemberRow }
	| { kind: "remove"; member: MemberRow }
	| { kind: "revoke"; invite: InviteRow }
	| null;

// Members (the owner labelled), guests, then people added by name who haven't joined; invite links below.
export function PeopleTab({ data }: { data: GroupData }) {
	const run = useRun();
	const invites = useInvites(data.group?.id ?? "") ?? [];
	const [dialog, setDialog] = useState<Dialog>(null);
	const groupId = data.group?.id ?? "";
	const me = data.me;

	const members = data.active.filter((m) => m.userId !== null && m.role !== "guest");
	const guests = data.active.filter((m) => m.userId !== null && m.role === "guest");
	const nameOnly = data.active.filter((m) => m.userId === null);

	const close = () => setDialog(null);
	const createInvite = async (claimMemberId: string | null) => {
		const plan = await run({ type: "createInvite", groupId, claimMemberId });
		if (plan.ok) toast.success("Link made");
	};

	const row = (member: MemberRow) => {
		const isMe = member.id === me?.id;
		const mayRename = data.can(isMe ? "member.rename.self" : "member.rename.others");
		const mayRemove = !isMe && data.can("member.remove.others");
		const mayInvite = member.userId === null && data.can("invite.create");
		return (
			<ListRow
				key={member.id}
				leading={<Face seed={member.id} name={member.displayName} size={36} />}
				title={member.displayName}
				subtitle={
					(isMe || member.role === "owner" || data.unsynced.has(member.id)) && (
						<Inline gap="control" wrap={false}>
							{isMe && <Badge tone="outline">You</Badge>}
							{member.role === "owner" && <Badge>Owner</Badge>}
							{data.unsynced.has(member.id) && <Badge tone="waiting">Not synced yet</Badge>}
						</Inline>
					)
				}
				trailing={
					(mayRename || mayRemove || mayInvite) && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button size="icon-sm" variant="ghost" aria-label={`More for ${member.displayName}`}>
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								{mayRename && (
									<DropdownMenuItem onSelect={() => setDialog({ kind: "rename", member })}>Rename</DropdownMenuItem>
								)}
								{mayInvite && (
									<DropdownMenuItem onSelect={() => void createInvite(member.id)}>
										Invite {member.displayName}
									</DropdownMenuItem>
								)}
								{mayRemove && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem tone="destructive" onSelect={() => setDialog({ kind: "remove", member })}>
											Remove
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					)
				}
			/>
		);
	};

	return (
		<Stack gap="section">
			<Section
				title="Members"
				action={
					data.can("member.add") && (
						<Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "add" })}>
							<Plus /> Add person
						</Button>
					)
				}
			>
				<List>{members.map(row)}</List>
			</Section>
			{guests.length > 0 && (
				<Section title="Guests">
					<List>{guests.map(row)}</List>
				</Section>
			)}
			{nameOnly.length > 0 && (
				<Section title="Not joined yet">
					<List>{nameOnly.map(row)}</List>
				</Section>
			)}

			{(data.can("invite.create") || invites.length > 0) && (
				<Section
					title="Invite links"
					action={
						data.can("invite.create") && (
							<Button size="sm" variant="secondary" onClick={() => void createInvite(null)}>
								<Link2 /> New link
							</Button>
						)
					}
				>
					{invites.length === 0 ? (
						<p className="type-body-sm text-muted-foreground">A link lets friends join this group for 14 days.</p>
					) : (
						<List>
							{invites.map((invite) => (
								<InviteListRow
									key={invite.id}
									invite={invite}
									data={data}
									onRevoke={() => setDialog({ kind: "revoke", invite })}
								/>
							))}
						</List>
					)}
				</Section>
			)}

			<NameDialog
				open={dialog?.kind === "add"}
				onOpenChange={(open) => !open && close()}
				title="Add person"
				submitLabel="Add person"
				onSave={async (displayName) => (await run({ type: "addPerson", groupId, displayName })).ok}
			/>
			<NameDialog
				open={dialog?.kind === "rename"}
				onOpenChange={(open) => !open && close()}
				title="Rename"
				submitLabel="Save"
				initial={dialog?.kind === "rename" ? dialog.member.displayName : ""}
				onSave={async (displayName) =>
					dialog?.kind === "rename"
						? (await run({ type: "renamePerson", groupId, memberId: dialog.member.id, displayName })).ok
						: false
				}
			/>
			<ConfirmDialog
				open={dialog?.kind === "remove"}
				onOpenChange={(open) => !open && close()}
				title={dialog?.kind === "remove" ? `Remove ${dialog.member.displayName}?` : "Remove?"}
				description="Their bills and debts stay, marked (left)."
				confirmLabel="Remove"
				tone="destructive"
				onConfirm={async () => {
					if (dialog?.kind === "remove") await run({ type: "removePerson", groupId, memberId: dialog.member.id });
				}}
			/>
			<ConfirmDialog
				open={dialog?.kind === "revoke"}
				onOpenChange={(open) => !open && close()}
				title="Revoke this link?"
				description="Nobody can join with it after this."
				confirmLabel="Revoke"
				tone="destructive"
				onConfirm={async () => {
					if (dialog?.kind === "revoke") await run({ type: "revokeInvite", groupId, inviteId: dialog.invite.id });
				}}
			/>
		</Stack>
	);
}

function InviteListRow({ invite, data, onRevoke }: { invite: InviteRow; data: GroupData; onRevoke: () => void }) {
	const token = useInviteToken(invite.id);
	const synced = invite.rowVersion > 0 && !data.unsynced.has(invite.id);
	const expired = invite.expiresAt < new Date().toISOString();
	const mine = invite.createdBy !== null && invite.createdBy === data.me?.userId;
	const mayRevoke = data.can(mine ? "invite.revoke.own" : "invite.revoke.others");
	// While the group is completed its links act as expired, so they can't be passed on.
	const paused = !!data.group?.completedAt;
	const ready = synced && !!token && !expired && !paused;
	const url = token ? inviteUrl(token) : null;
	const claim = invite.claimMemberId ? data.names.member(invite.claimMemberId) : undefined;

	return (
		<ListRow
			leading={
				<span className="inline-flex size-9 items-center justify-center rounded-full bg-sunken">
					<Link2 className="size-[1.125rem]" aria-hidden />
				</span>
			}
			title={claim ? `For ${claim.displayName}` : "Anyone with the link"}
			subtitle={
				<Inline gap="control" wrap={false}>
					<span className="truncate">
						{paused
							? "Paused while completed"
							: expired
								? "Expired"
								: `Expires ${shortDate(invite.expiresAt, todayIso())}`}
						{token === null && " · on another device"}
					</span>
					{!synced && <Badge tone="waiting">Not synced yet</Badge>}
				</Inline>
			}
			trailing={
				<Inline gap="none" wrap={false}>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label="Copy link"
						title="Copy link"
						disabled={!ready}
						onClick={() => url && void copyLink(url)}
					>
						<Copy />
					</Button>
					{mayRevoke && (
						<Button size="icon-sm" variant="ghost" aria-label="Revoke link" title="Revoke link" onClick={onRevoke}>
							<X />
						</Button>
					)}
				</Inline>
			}
		/>
	);
}
