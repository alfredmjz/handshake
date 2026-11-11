import { useRef } from "react";

import { EntryListRow } from "@/components/group/entry-list-row";
import type { GroupData } from "@/components/group/group-data";
import { todayIso } from "@/components/group/today";
import { EmptyState } from "@/components/notices";
import { Plot } from "@/components/ui/hairline";
import { List, ListHeading } from "@/components/ui/list";
import { dayLabel, groupByDay, isVisibleTo } from "@/lib/group-view";

// Bills and payments, newest day first. Payments that don't count yet show only to their two people.
export function EntriesTab({ data }: { data: GroupData }) {
	const visible = data.entries.filter((e) => isVisibleTo(e, data.me?.id));
	const today = todayIso();
	// What was here when the list opened stays still; anything added after lands.
	const seen = useRef<Set<string> | null>(null);
	seen.current ??= new Set(visible.map((e) => e.id));
	const shown = seen.current;

	if (visible.length === 0) {
		return (
			<EmptyState
				art={<Plot play intensity={0.6} aria-label="" aria-hidden className="w-48" />}
				title="No expenses yet."
			/>
		);
	}

	return (
		<div>
			{groupByDay(visible).map((day) => (
				<section key={day.date}>
					<ListHeading>{dayLabel(day.date, today)}</ListHeading>
					<List>
						{day.entries.map((entry) => (
							<EntryListRow
								key={entry.id}
								entry={entry}
								names={data.names}
								myMemberId={data.me?.id}
								unsynced={data.unsynced.has(entry.id)}
								needsResolving={data.conflictedIds.has(entry.id)}
								to={`/groups/${entry.groupId}/entries/${entry.id}`}
								arrived={!shown.has(entry.id)}
							/>
						))}
					</List>
				</section>
			))}
		</div>
	);
}
