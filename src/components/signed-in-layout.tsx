import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router";
import { toast } from "sonner";

import { SyncStatusBadge } from "@/components/sync-status";
import { Button } from "@/components/ui/button";
import { CurrentUserProvider, signOut, type CurrentUser } from "@/lib/auth";
import { claimLocalData, db } from "@/lib/local-db";
import { startSync } from "@/lib/sync/controller";
import { createDexieSyncStore } from "@/lib/sync/dexie-store";
import { supabaseTransport } from "@/lib/sync/supabase-transport";

export function SignedInLayout({ user }: { user: CurrentUser }) {
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let stop: (() => void) | undefined;
		let cancelled = false;

		void claimLocalData(user.id).then(() => {
			if (cancelled) return;
			stop = startSync(createDexieSyncStore(db, user.id), supabaseTransport, (rejected) => {
				for (const { reason } of rejected) toast.error("A change couldn't be saved", { description: reason });
			});
			setReady(true);
		});

		return () => {
			cancelled = true;
			stop?.();
		};
	}, [user.id]);

	if (!ready) return null;

	return (
		<CurrentUserProvider value={user}>
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
		</CurrentUserProvider>
	);
}
