import { useEffect, useMemo, useState } from "react";
import { Link, Outlet } from "react-router";
import { toast } from "sonner";

import { SyncStatusBadge } from "@/components/sync-status";
import { Button } from "@/components/ui/button";
import { CurrentUserProvider, signOut, type CurrentUser } from "@/lib/auth";
import { CommitProvider, createCommitter, type Commit } from "@/lib/changes";
import { newId, randomToken } from "@/lib/ids";
import { claimLocalData, db } from "@/lib/local-db";
import { requestSync, startSync } from "@/lib/sync/controller";
import { createDexieSyncStore } from "@/lib/sync/dexie-store";
import { supabaseTransport } from "@/lib/sync/supabase-transport";
import type { RejectedMutation } from "@/lib/sync/types";

// The spec's rejection toasts: one per code, with the server's reason underneath.
function showRejected({ code, reason }: RejectedMutation) {
	if (code === "HS409") toast.error(reason);
	else if (code === "HS403") toast.error("You can't do that in this group", { description: reason });
	else toast.error("That change couldn't be saved", { description: reason });
}

export function SignedInLayout({ user }: { user: CurrentUser }) {
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let stop: (() => void) | undefined;
		let cancelled = false;

		void claimLocalData(user.id).then(() => {
			if (cancelled) return;
			stop = startSync(createDexieSyncStore(db, user.id), supabaseTransport, (rejected) => {
				rejected.forEach(showRejected);
			});
			setReady(true);
		});

		return () => {
			cancelled = true;
			stop?.();
		};
	}, [user.id]);

	// Rebuilt when a guest adds their email, so the planner knows they may now create groups.
	const commit = useMemo<Commit>(() => {
		const inner = createCommitter({
			db,
			userId: user.id,
			isAnonymous: user.isAnonymous,
			requestSync,
			newId,
			randomToken,
			now: () => new Date(),
		});
		return async (intent) => {
			try {
				return await inner(intent);
			} catch (error) {
				toast.error("Couldn't save on this device", {
					description: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		};
	}, [user.id, user.isAnonymous]);

	if (!ready) return null;

	return (
		<CurrentUserProvider value={user}>
			<CommitProvider value={commit}>
				<div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-10 pt-[max(0.75rem,env(safe-area-inset-top))]">
					<header className="flex items-center justify-between gap-3 py-3">
						<Link
							to="/"
							className="type-h4 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							Handshake
						</Link>
						<div className="flex items-center gap-2">
							<SyncStatusBadge />
							<Button variant="ghost" size="sm" onClick={() => void signOut()}>
								Sign out
							</Button>
						</div>
					</header>
					<main className="flex-1 pt-4">
						<Outlet />
					</main>
				</div>
			</CommitProvider>
		</CurrentUserProvider>
	);
}
