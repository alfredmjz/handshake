import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { CheckDoodle, HandshakeMark } from "@/components/art/doodles";
import { Face } from "@/components/art/face";
import { EmptyState } from "@/components/notices";
import { Screen, ScreenHeader } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { Stack } from "@/components/ui/stack";
import { defaultDisplayName, signInAsGuest, useCurrentUser } from "@/lib/auth";
import { useOnline } from "@/lib/online";
import { requestSync } from "@/lib/sync/controller";
import { joinGroup, previewInvite, TransportError, type InvitePreview } from "@/lib/sync/supabase-transport";
import { byText } from "@/lib/utils";
import { EmailSignIn } from "@/pages/sign-in";

type Loaded = { token: string } & ({ preview: InvitePreview } | { error: "gone" | "failed" });

function usePreview(token: string | undefined, online: boolean) {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		if (!token || !online) return;
		let cancelled = false;
		previewInvite(token).then(
			(preview) => !cancelled && setLoaded({ token, preview }),
			(error) =>
				!cancelled &&
				setLoaded({ token, error: error instanceof TransportError && error.code === "HS404" ? "gone" : "failed" })
		);
		return () => {
			cancelled = true;
		};
	}, [token, online]);
	return loaded && loaded.token === token ? loaded : null;
}

function Frame({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
	if (signedIn) return <>{children}</>;
	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-page pb-section pt-[max(var(--space-section),env(safe-area-inset-top))]">
			<header className="flex items-center gap-control pb-section">
				<HandshakeMark className="h-8 w-12" />
				<span className="type-wordmark">handshake</span>
			</header>
			{children}
		</div>
	);
}

// /join/:token. Signed out you pick an account or guest first; the URL stays, so you land back here to join.
export function JoinPage({ signedIn }: { signedIn: boolean }) {
	const { token } = useParams();
	const online = useOnline();
	const loaded = usePreview(token, online);

	let body: ReactNode = null;
	if (!online) {
		body = <EmptyState kind="shake" title="Joining needs a connection." />;
	} else if (loaded && "error" in loaded) {
		body = (
			<EmptyState
				title={
					loaded.error === "gone"
						? "This invite link doesn't work any more. Ask for a new one."
						: "Couldn't open this invite. Try again in a moment."
				}
			/>
		);
	} else if (loaded) {
		body = signedIn ? (
			<JoinSignedIn token={loaded.token} preview={loaded.preview} />
		) : (
			<JoinSignedOut preview={loaded.preview} />
		);
	}

	return (
		<Frame signedIn={signedIn}>
			<Screen className="w-full flex-1">{body}</Screen>
		</Frame>
	);
}

function JoinHeader({ preview }: { preview: InvitePreview }) {
	return (
		<ScreenHeader
			eyebrow={preview.invitedBy ? `${preview.invitedBy} invited you to` : "You're invited to"}
			title={preview.groupName}
		/>
	);
}

function JoinSignedOut({ preview }: { preview: InvitePreview }) {
	const [account, setAccount] = useState(false);
	const [busy, setBusy] = useState(false);

	async function asGuest() {
		setBusy(true);
		try {
			await signInAsGuest();
		} catch (error) {
			toast.error("Couldn't continue as a guest", { description: error instanceof Error ? error.message : undefined });
			setBusy(false);
		}
	}

	return (
		<>
			<JoinHeader preview={preview} />
			{account ? (
				<Card>
					<EmailSignIn onBack={() => setAccount(false)} />
				</Card>
			) : (
				<Stack>
					<Button size="lg" className="w-full" onClick={() => setAccount(true)}>
						Create an account
					</Button>
					<Button size="lg" variant="outline" className="w-full" disabled={busy} onClick={() => void asGuest()}>
						Continue as guest
					</Button>
				</Stack>
			)}
		</>
	);
}

const NOT_LISTED = "none";

function JoinSignedIn({ token, preview }: { token: string; preview: InvitePreview }) {
	const user = useCurrentUser();
	const navigate = useNavigate();
	const [claim, setClaim] = useState<string>(preview.claimMemberId ?? NOT_LISTED);
	const [name, setName] = useState(user.isAnonymous ? "" : defaultDisplayName(user.email));
	const [busy, setBusy] = useState(false);
	const people = [...preview.unclaimed].sort(byText((p) => p.displayName));

	if (preview.alreadyMember) {
		return (
			<>
				<ScreenHeader eyebrow="You're already in" title={preview.groupName} />
				<Button size="lg" onClick={() => navigate(`/groups/${preview.groupId}`)}>
					Open group
				</Button>
			</>
		);
	}

	const claiming = claim !== NOT_LISTED;
	const nameOk = claiming || name.trim().length > 0;

	async function join() {
		setBusy(true);
		try {
			const groupId = await joinGroup({
				token,
				claimMemberId: claiming ? claim : undefined,
				displayName: claiming ? undefined : name.trim(),
			});
			requestSync();
			navigate(`/groups/${groupId}`, { replace: true });
		} catch (error) {
			setBusy(false);
			if (error instanceof TransportError && error.code === "HS404")
				toast.error("This invite link doesn't work any more");
			else if (error instanceof TransportError && error.code === "network") toast.error("Joining needs a connection");
			else toast.error("Couldn't join", { description: error instanceof Error ? error.message : undefined });
		}
	}

	return (
		<>
			<JoinHeader preview={preview} />
			{people.length > 0 && (
				<FieldSet legend="Which one are you?">
					<List role="radiogroup" aria-label="Which one are you?">
						{people.map((p) => (
							<ListRow
								key={p.memberId}
								asChild
								leading={<Face seed={p.memberId} name="" size={32} />}
								title={p.displayName}
								trailing={claim === p.memberId ? <CheckDoodle className="size-5" /> : undefined}
							>
								<button
									type="button"
									role="radio"
									aria-checked={claim === p.memberId}
									onClick={() => setClaim(p.memberId)}
								/>
							</ListRow>
						))}
						<ListRow
							asChild
							title="I'm not on this list"
							trailing={!claiming ? <CheckDoodle className="size-5" /> : undefined}
						>
							<button type="button" role="radio" aria-checked={!claiming} onClick={() => setClaim(NOT_LISTED)} />
						</ListRow>
					</List>
				</FieldSet>
			)}
			{!claiming && (
				<Field label="Your name" htmlFor="join-name">
					<Input id="join-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
				</Field>
			)}
			<Button size="lg" disabled={busy || !nameOk} onClick={() => void join()}>
				{busy ? "Joining…" : `Join ${preview.groupName}`}
			</Button>
		</>
	);
}
