import { useState, type FormEvent } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import { Link, useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/lib/auth";
import { renameGroup, useGroup, useMembers } from "@/lib/groups";

export function GroupPage() {
	const { groupId = "" } = useParams();
	const user = useCurrentUser();
	const group = useGroup(groupId);
	const members = useMembers(groupId);
	const [draft, setDraft] = useState<string | null>(null);

	if (group === undefined) return null;

	if (group === null || group.deletedAt) {
		return (
			<div className="space-y-4">
				<p className="type-body text-muted-foreground">This group isn't on this device.</p>
				<Button asChild variant="outline">
					<Link to="/">Back to groups</Link>
				</Button>
			</div>
		);
	}

	async function onRename(event: FormEvent) {
		event.preventDefault();
		const name = draft?.trim();
		if (name && name !== group?.name) await renameGroup(user, groupId, name);
		setDraft(null);
	}

	return (
		<div className="space-y-6">
			<Link to="/" className="type-body-sm inline-flex items-center gap-1.5 text-muted-foreground hover:text-primary">
				<ArrowLeft className="size-4" aria-hidden />
				Groups
			</Link>

			{draft === null ? (
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h1 className="type-h2 break-words">{group.name}</h1>
						<p className="type-body-sm text-muted-foreground">
							{group.baseCurrency}
							{group.rowVersion === 0 ? " · Not synced yet" : ""}
						</p>
					</div>
					<Button variant="outline" size="sm" onClick={() => setDraft(group.name)}>
						<Pencil aria-hidden />
						Rename
					</Button>
				</div>
			) : (
				<form onSubmit={onRename} className="space-y-2">
					<Label htmlFor="group-name">Group name</Label>
					<div className="flex gap-2">
						<Input id="group-name" autoFocus maxLength={80} value={draft} onChange={(e) => setDraft(e.target.value)} />
						<Button type="submit" className="h-10" disabled={!draft.trim()}>
							Save
						</Button>
						<Button type="button" variant="ghost" className="h-10" onClick={() => setDraft(null)}>
							Cancel
						</Button>
					</div>
				</form>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Members</CardTitle>
				</CardHeader>
				<CardContent>
					<ul className="space-y-2">
						{members?.map((member) => (
							<li key={member.id} className="flex items-center justify-between gap-3">
								<span className="type-body truncate">
									{member.displayName}
									{member.userId === user.id ? " (you)" : ""}
								</span>
								{member.role === "owner" && <span className="type-caption text-muted-foreground">Owner</span>}
							</li>
						))}
					</ul>
				</CardContent>
			</Card>
		</div>
	);
}
