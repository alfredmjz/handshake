import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { conflictSentence } from "@/components/group/conflict-resolver";
import type { GroupData } from "@/components/group/group-data";
import { useEntry } from "@/lib/entries";

const SHOWN_KEY = "handshake.shownConflicts";

function readShown(): Set<string> {
	try {
		const raw = localStorage.getItem(SHOWN_KEY);
		const ids: unknown = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function writeShown(ids: Set<string>) {
	try {
		// The newest few hundred are plenty: a resolved conflict never comes back.
		localStorage.setItem(SHOWN_KEY, JSON.stringify([...ids].slice(-500)));
	} catch {
		// Private mode or storage full: the popup may show again next time.
	}
}

// Once per new conflict, when the group opens: "Dinner was changed by Alex and Sam at the same time".
// Members only; guests see the badge and wait.
export function ConflictPopup({ data, onResolve }: { data: GroupData; onResolve: (entryId: string) => void }) {
	const [shown, setShown] = useState(readShown);
	const mayResolve = data.can("conflict.resolve");
	const next = mayResolve ? data.conflicts.find((c) => !shown.has(c.id)) : undefined;
	// Deleted bills aren't in the group's list, and a conflict can be about one.
	const entry = useEntry(next?.entryId ?? "");

	const markShown = () => {
		if (!next) return;
		const ids = new Set(shown).add(next.id);
		writeShown(ids);
		setShown(ids);
	};

	if (!next || !entry || entry.id !== next.entryId) return null;
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => !open && markShown()}
			title={`${conflictSentence(entry, next, data.names)}.`}
			description="Pick what to keep, field by field."
			confirmLabel="Resolve now"
			cancelLabel="Later"
			onConfirm={() => {
				markShown();
				onResolve(entry.id);
			}}
		/>
	);
}
