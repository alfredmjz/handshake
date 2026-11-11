import { useEffect, useMemo, useState } from "react";
import { LogOut, Settings } from "lucide-react";
import { Link, Outlet, useNavigate } from "react-router";
import { toast } from "sonner";

import { HandshakeMark } from "@/components/art/doodles";
import { Face } from "@/components/art/face";
import { GuestBanner } from "@/components/guest-banner";
import { NudgeBell } from "@/components/nudge-bell";
import { SyncStatusBadge } from "@/components/sync-status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Inline } from "@/components/ui/stack";
import { CurrentUserProvider, endIfAccountGone, signOut, type CurrentUser } from "@/lib/auth";
import { CommitProvider, createCommitter, type Commit } from "@/lib/changes";
import { newId } from "@/lib/ids";
import { claimLocalData, db } from "@/lib/local-db";
import { requestSync, startSync } from "@/lib/sync/controller";
import { createDexieSyncStore, resetCursors } from "@/lib/sync/dexie-store";
import { supabaseTransport } from "@/lib/sync/supabase-transport";

// The spec's rejection toasts, for a refused plan or a mutation push_changes rejected; reason is the detail.
export function showRefusal(code: string | undefined, reason: string) {
	if (code === "HS409") toast.error(reason);
	else if (code === "HS403") toast.error("You can't do that in this group", { description: reason });
	else if (code === "HS422") toast.error("That change couldn't be saved", { description: reason });
	else toast.error("A change couldn't be saved", { description: reason });
}

export function SignedInLayout({ user }: { user: CurrentUser }) {
	const [ready, setReady] = useState(false);
	const navigate = useNavigate();

	// Rebuilt when a guest adds their email (isAnonymous changes) or another account signs in.
	const commit = useMemo<Commit>(() => {
		const committer = createCommitter({
			db,
			userId: user.id,
			isAnonymous: user.isAnonymous,
			requestSync,
			newId,
			now: () => new Date(),
		});
		return async (intent) => {
			try {
				return await committer(intent);
			} catch (error) {
				toast.error("Couldn't save on this device");
				throw error;
			}
		};
	}, [user.id, user.isAnonymous]);

	useEffect(() => {
		let stop: (() => void) | undefined;
		let cancelled = false;

		void claimLocalData(user.id).then(() => {
			if (cancelled) return;
			stop = startSync(createDexieSyncStore(db, user.id), supabaseTransport, (rejected) => {
				for (const { code, reason } of rejected) showRefusal(code, reason);
				// Rejected changes still show on this device; a full pull replaces them with the server's rows.
				void resetCursors(db).then(requestSync);
			});
			setReady(true);
		});

		return () => {
			cancelled = true;
			stop?.();
		};
	}, [user.id]);

	// A guest's login is deleted when their group is completed: notice it on start, reconnect and reopen.
	useEffect(() => {
		const check = () => void endIfAccountGone(user);
		const checkIfVisible = () => {
			if (document.visibilityState === "visible") check();
		};
		check();
		window.addEventListener("online", check);
		document.addEventListener("visibilitychange", checkIfVisible);
		return () => {
			window.removeEventListener("online", check);
			document.removeEventListener("visibilitychange", checkIfVisible);
		};
	}, [user]);

	if (!ready) return null;

	return (
		<CurrentUserProvider value={user}>
			<CommitProvider value={commit}>
				<div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-page pb-section pt-[env(safe-area-inset-top)]">
					<header className="flex items-center justify-between gap-stack py-1 sm:py-row">
						<Link
							to="/"
							aria-label="Handshake, home"
							className="flex items-center gap-control rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<HandshakeMark className="h-8 w-12" />
							{/* Phones keep the mark only, so the bell, sync badge and account fit at 375px. */}
							<span className="type-wordmark hidden sm:inline">handshake</span>
						</Link>
						<Inline wrap={false}>
							<NudgeBell />
							<SyncStatusBadge />
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="icon" aria-label="Account" title="Account" className="rounded-full">
										<Face seed={user.id} name="" size={36} />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent>
									<DropdownMenuLabel>{user.isAnonymous ? "Guest" : user.email}</DropdownMenuLabel>
									<DropdownMenuItem onSelect={() => navigate("/settings")}>
										<Settings className="size-4" aria-hidden />
										Settings
									</DropdownMenuItem>
									{/* A guest who signs out can't sign back in; their way back is their code. */}
									{!user.isAnonymous && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem onSelect={() => void signOut()}>
												<LogOut className="size-4" aria-hidden />
												Sign out
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</Inline>
					</header>
					{user.isAnonymous && <GuestBanner />}
					<main className="flex-1 pt-control sm:pt-section">
						<Outlet />
					</main>
				</div>
			</CommitProvider>
		</CurrentUserProvider>
	);
}
