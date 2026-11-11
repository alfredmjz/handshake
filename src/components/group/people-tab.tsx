import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";

import { Face } from "@/components/art/face";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { GroupCode } from "@/components/group/group-code";
import type { GroupData } from "@/components/group/group-data";
import { NameDialog } from "@/components/group/name-dialog";
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
import { isNameTaken } from "@/lib/changes";
import { formatCode } from "@/lib/code-format";
import { useGuestCodes } from "@/lib/codes";
import type { MemberRow } from "@/lib/sync/types";

type Dialog = { kind: "add" } | { kind: "rename"; member: MemberRow } | { kind: "remove"; member: MemberRow } | null;

// Members (the owner labelled), guests, then people added by name who haven't joined; the group code below.
// The owner sees each guest's personal code, and a guest their own; other members see none.
export function PeopleTab({ data }: { data: GroupData }) {
	const run = useRun();
	const [dialog, setDialog] = useState<Dialog>(null);
	const groupId = data.group?.id ?? "";
	const me = data.me;
	const guestCodes = useGuestCodes(groupId);

	const members = data.active.filter((m) => m.userId !== null && m.role !== "guest");
	const guests = data.active.filter((m) => m.userId !== null && m.role === "guest");
	const nameOnly = data.active.filter((m) => m.userId === null);

	const close = () => setDialog(null);

	const row = (member: MemberRow) => {
		const isMe = member.id === me?.id;
		const mayRename = data.can(isMe ? "member.rename.self" : "member.rename.others");
		const mayRemove = !isMe && data.can("member.remove.others");
		const code = member.role === "guest" ? guestCodes?.get(member.id) : undefined;
		const codeLabel = isMe ? "Your code to get back in" : `${member.displayName}'s code`;
		return (
			<ListRow
				key={member.id}
				leading={<Face seed={member.id} name={member.displayName} size={36} />}
				title={member.displayName}
				subtitle={
					(isMe || member.role === "owner" || data.unsynced.has(member.id) || code) && (
						<Inline gap="control" wrap={false}>
							{isMe && <Badge tone="outline">You</Badge>}
							{member.role === "owner" && <Badge>Owner</Badge>}
							{data.unsynced.has(member.id) && <Badge tone="waiting">Not synced yet</Badge>}
							{code && (
								<span className="truncate" title={codeLabel}>
									<span className="sr-only">{codeLabel}: </span>
									<span className="font-semibold tracking-[0.08em] text-ink">{formatCode(code)}</span>
								</span>
							)}
						</Inline>
					)
				}
				trailing={
					(code || mayRename || mayRemove) && (
						<Inline gap="none" wrap={false}>
							{code && (
								<CopyButton text={formatCode(code)} label={`Copy ${codeLabel.toLowerCase()}`} done="Code copied" />
							)}
							{(mayRename || mayRemove) && (
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
							)}
						</Inline>
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

			{data.me && data.me.role !== "guest" && <GroupCode data={data} />}

			<NameDialog
				open={dialog?.kind === "add"}
				onOpenChange={(open) => !open && close()}
				title="Add person"
				submitLabel="Add person"
				taken={(name) => isNameTaken(data.members, name)}
				onSave={async (displayName) => (await run({ type: "addPerson", groupId, displayName })).ok}
			/>
			<NameDialog
				open={dialog?.kind === "rename"}
				onOpenChange={(open) => !open && close()}
				title="Rename"
				submitLabel="Save"
				initial={dialog?.kind === "rename" ? dialog.member.displayName : ""}
				taken={(name) => isNameTaken(data.members, name, dialog?.kind === "rename" ? dialog.member.id : null)}
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
		</Stack>
	);
}
