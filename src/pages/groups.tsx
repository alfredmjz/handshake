import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/lib/auth";
import { createGroup, useGroups } from "@/lib/groups";

export function GroupsPage() {
	const user = useCurrentUser();
	const groups = useGroups();
	const navigate = useNavigate();
	const [name, setName] = useState("");

	async function onCreate(event: FormEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		const groupId = await createGroup(user, trimmed);
		setName("");
		navigate(`/groups/${groupId}`);
	}

	return (
		<div className="space-y-6">
			<h1 className="type-h2">Groups</h1>

			<form onSubmit={onCreate} className="flex gap-2">
				<Label htmlFor="new-group" className="sr-only">
					New group name
				</Label>
				<Input
					id="new-group"
					placeholder="Japan 2027, Roommates…"
					maxLength={80}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<Button type="submit" className="h-10" disabled={!name.trim()}>
					<Plus aria-hidden />
					Create
				</Button>
			</form>

			{groups === undefined ? null : groups.length === 0 ? (
				<Card>
					<CardContent className="p-6 text-center type-body text-muted-foreground">
						No groups yet. Make one for a trip, a household or a night out.
					</CardContent>
				</Card>
			) : (
				<Card className="overflow-hidden">
					<ul className="divide-y divide-border">
						{groups.map((group) => (
							<li key={group.id}>
								<Link
									to={`/groups/${group.id}`}
									className="row-interactive flex items-center justify-between gap-3 px-4 py-3"
								>
									<span className="type-body-lg truncate font-medium">{group.name}</span>
									<span className="type-caption shrink-0 text-muted-foreground">
										{group.rowVersion === 0 ? "Not synced yet" : group.baseCurrency}
									</span>
								</Link>
							</li>
						))}
					</ul>
				</Card>
			)}
		</div>
	);
}
