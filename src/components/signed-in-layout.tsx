import { useEffect, useMemo, useState } from "react";
import { LogOut, Settings, Users } from "lucide-react";
import { Link, Outlet, useNavigate } from "react-router";
import { toast } from "sonner";

import { Face } from "@/components/art/face";
import { MarginDoodles } from "@/components/art/marks";
import { HandsGlyph } from "@/components/art/hands-glyph";
import { GuestBanner } from "@/components/guest-banner";
import { NudgeBell } from "@/components/nudge-bell";
import { SyncMark, useSyncState } from "@/components/sync-status";
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
import {
	currentTestAccount,
	devLoginAvailable,
	switchToTestAccount,
	TEST_ACCOUNTS,
	type TestAccount,
} from "@/lib/dev-login";
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
				// A refusal can mean the account itself is gone (deleted, or a guest whose group was completed): if so,
				// sign out here instead of showing the server's error for every change.
				void endIfAccountGone(user).then((gone) => {
					if (!gone) for (const { code, reason } of rejected) showRefusal(code, reason);
				});
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

	return <Shell user={user} commit={commit} />;
}

// Local development only: switch to another test account without going back to the Welcome screen.
function TestAccountItems() {
	const [current, setCurrent] = useState<TestAccount | null>(null);
	useEffect(() => {
		void currentTestAccount().then(setCurrent);
	}, []);
	return (
		<>
			<DropdownMenuSeparator />
			<DropdownMenuLabel className="type-caption text-muted-foreground">Test accounts (local)</DropdownMenuLabel>
			{TEST_ACCOUNTS.map((account) => (
				<DropdownMenuItem
					key={account.id}
					disabled={account.id === current}
					onSelect={() =>
						void switchToTestAccount(account.id).catch((error: Error) =>
							toast.error("Couldn't switch", { description: error.message })
						)
					}
				>
					<Users className="size-4" aria-hidden />
					{account.id === current ? `${account.label} (you)` : `Switch to ${account.label}`}
				</DropdownMenuItem>
			))}
		</>
	);
}

function Shell({ user, commit }: { user: CurrentUser; commit: Commit }) {
	const navigate = useNavigate();
	const sync = useSyncState();

	return (
		<CurrentUserProvider value={user}>
			<CommitProvider value={commit}>
				<MarginDoodles />
				<div className="relative mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-page pb-section pt-[env(safe-area-inset-top)]">
					<header className="flex h-16 items-center justify-between gap-stack">
						<Link
							to="/"
							aria-label="Handshake, home"
							className="-ml-1 flex min-h-tap items-center gap-control rounded-full px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<SyncMark state={sync.state} waiting={sync.waiting} className="h-7 w-11" />
							<span className="type-wordmark">handshake</span>
						</Link>
						<span className="sr-only" aria-live="polite">
							{sync.state === "synced" ? "" : sync.spoken}
						</span>
						<Inline gap="control" wrap={false}>
							<NudgeBell />
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="icon" aria-label="Account" title="Account" className="rounded-full">
										<Face seed={user.id} name="" size={32} />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuLabel>{user.isAnonymous ? "Guest" : user.email}</DropdownMenuLabel>
									<DropdownMenuItem onSelect={(e) => (e.preventDefault(), requestSync())}>
										<HandsGlyph
											pose={sync.state === "syncing" ? "shaking" : "clasped"}
											strokeWidth={6}
											className="h-4 w-6"
										/>
										<span className="flex flex-col">
											Sync now
											<span className="type-caption text-muted-foreground">
												{sync.error ? `${sync.spoken}: couldn't reach the server` : sync.spoken}
											</span>
										</span>
									</DropdownMenuItem>
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
									{import.meta.env.DEV && devLoginAvailable() && <TestAccountItems />}
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
