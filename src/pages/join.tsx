import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { CheckDoodle, HandshakeMark } from "@/components/art/doodles";
import { Face } from "@/components/art/face";
import type { GuestCodeSheetState } from "@/components/guest-code-sheet";
import { EmptyState } from "@/components/notices";
import { Screen, ScreenHeader } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { Stack } from "@/components/ui/stack";
import { defaultDisplayName, signInAsGuest, useCurrentUser } from "@/lib/auth";
import { normaliseCode } from "@/lib/code-format";
import { useOnline } from "@/lib/online";
import { requestSync } from "@/lib/sync/controller";
import { joinWithCode, previewGroup, TransportError, type GroupPreview } from "@/lib/sync/supabase-transport";
import { byText } from "@/lib/utils";
import { EmailSignIn } from "@/pages/sign-in";

const DOESNT_WORK = "This code doesn't work";

// Opening the code of a group you're in takes you straight into it; a screen saying so would be a dead end.
function AlreadyIn({ groupId, groupName }: { groupId: string; groupName: string }) {
	const navigate = useNavigate();
	useEffect(() => {
		toast(`You're already in ${groupName}`);
		navigate(`/groups/${groupId}`, { replace: true });
	}, [groupId, groupName, navigate]);
	return null;
}

type Loaded = { code: string } & ({ preview: GroupPreview } | { error: "gone" | "failed" });

function usePreview(code: string | null, online: boolean) {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		if (!code || !online) return;
		let cancelled = false;
		previewGroup(code).then(
			(preview) => !cancelled && setLoaded({ code, preview }),
			(error) =>
				!cancelled &&
				setLoaded({ code, error: error instanceof TransportError && error.code === "HS404" ? "gone" : "failed" })
		);
		return () => {
			cancelled = true;
		};
	}, [code, online]);
	return loaded && loaded.code === code ? loaded : null;
}

// Which way in: a name-only person, someone new, or a guest coming back with their personal code.
type Choice = { kind: "claim"; memberId: string } | { kind: "new" } | { kind: "back"; memberId: string | null };

type Draft = { choice: Choice | null; name: string; personalCode: string };

// Signed out, the choice is kept across the account or guest step (the URL stays); back signed in, the
// join screen finishes it once.
const stashKey = (code: string) => `handshake.join.${code}`;

function stash(code: string, draft: Draft) {
	try {
		sessionStorage.setItem(stashKey(code), JSON.stringify(draft));
	} catch {
		// Without storage the choice is simply asked again.
	}
}

function takeStash(code: string): Draft | null {
	try {
		const raw = sessionStorage.getItem(stashKey(code));
		sessionStorage.removeItem(stashKey(code));
		return raw ? (JSON.parse(raw) as Draft) : null;
	} catch {
		return null;
	}
}

function draftReady(draft: Draft): boolean {
	const { choice } = draft;
	if (!choice) return false;
	if (choice.kind === "new") return draft.name.trim().length > 0;
	if (choice.kind === "back") return choice.memberId !== null && normaliseCode(draft.personalCode) !== null;
	return true;
}

function nameTaken(preview: GroupPreview, name: string): boolean {
	const key = name.trim().toLowerCase();
	return [...preview.unclaimed, ...preview.returning].some((p) => p.displayName.trim().toLowerCase() === key);
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

// /join/:code (a group code, or anything normaliseCode reads). Signed out you choose who you are, then an
// account or guest; the URL stays, so you land back here and the join finishes.
export function JoinPage({ signedIn }: { signedIn: boolean }) {
	const params = useParams();
	const code = normaliseCode(params.code ?? "");
	const online = useOnline();
	const loaded = usePreview(code, online);
	const [gone, setGone] = useState(false);

	let body: ReactNode = null;
	if (!code || gone || (loaded && "error" in loaded && loaded.error === "gone")) {
		body = <EmptyState title={`${DOESNT_WORK}. Ask for the group's code again.`} />;
	} else if (!online) {
		body = <EmptyState kind="shake" title="Joining needs a connection." />;
	} else if (loaded && "error" in loaded) {
		body = <EmptyState title="Couldn't open this code. Try again in a moment." />;
	} else if (loaded) {
		body = signedIn ? (
			<SignedInJoinChoice key={loaded.code} code={loaded.code} preview={loaded.preview} onGone={() => setGone(true)} />
		) : (
			<JoinChoice key={loaded.code} code={loaded.code} preview={loaded.preview} onGone={() => setGone(true)} />
		);
	}

	return (
		<Frame signedIn={signedIn}>
			<Screen className="w-full flex-1">{body}</Screen>
		</Frame>
	);
}

function PersonRadio({
	id,
	name,
	checked,
	onPick,
}: {
	id: string;
	name: string;
	checked: boolean;
	onPick: () => void;
}) {
	return (
		<ListRow
			asChild
			leading={<Face seed={id} name="" size={32} />}
			title={name}
			trailing={checked ? <CheckDoodle className="size-5" /> : undefined}
		>
			<button type="button" role="radio" aria-checked={checked} onClick={onPick} />
		</ListRow>
	);
}

function OptionRadio({ title, checked, onPick }: { title: string; checked: boolean; onPick: () => void }) {
	return (
		<ListRow asChild title={title} trailing={checked ? <CheckDoodle className="size-5" /> : undefined}>
			<button type="button" role="radio" aria-checked={checked} onClick={onPick} />
		</ListRow>
	);
}

type ChoiceProps = { code: string; preview: GroupPreview; onGone: () => void };

// An account's own name fills "I'm new here".
function SignedInJoinChoice(props: ChoiceProps) {
	const user = useCurrentUser();
	return <JoinChoice {...props} signedIn defaultName={user.isAnonymous ? "" : defaultDisplayName(user.email)} />;
}

function JoinChoice({
	code,
	preview,
	onGone,
	signedIn = false,
	defaultName = "",
}: ChoiceProps & { signedIn?: boolean; defaultName?: string }) {
	const navigate = useNavigate();
	const [restored] = useState(() => (signedIn ? takeStash(code) : null));
	const [choice, setChoice] = useState<Choice | null>(
		restored?.choice ?? (preview.unclaimed.length === 0 && preview.returning.length === 0 ? { kind: "new" } : null)
	);
	const [name, setName] = useState(restored?.name || defaultName);
	const [personalCode, setPersonalCode] = useState(restored?.personalCode ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [account, setAccount] = useState(false);

	const unclaimed = [...preview.unclaimed].sort(byText((p) => p.displayName));
	const returning = [...preview.returning].sort(byText((p) => p.displayName));
	const draft: Draft = { choice, name, personalCode };
	const clash = choice?.kind === "new" && name.trim().length > 0 && nameTaken(preview, name);
	const ready = draftReady(draft) && !clash;

	const pick = (next: Choice) => {
		setChoice(next);
		setError(null);
	};

	const header = (
		<ScreenHeader eyebrow={preview.ownerName ? `${preview.ownerName}'s group` : "A group"} title={preview.groupName} />
	);

	if (signedIn && preview.alreadyMember) return <AlreadyIn groupId={preview.groupId} groupName={preview.groupName} />;

	return (
		<>
			{header}
			<FieldSet legend="Which one are you?">
				<List role="radiogroup" aria-label="Which one are you?">
					{unclaimed.map((p) => (
						<PersonRadio
							key={p.memberId}
							id={p.memberId}
							name={p.displayName}
							checked={choice?.kind === "claim" && choice.memberId === p.memberId}
							onPick={() => pick({ kind: "claim", memberId: p.memberId })}
						/>
					))}
					<OptionRadio title="I'm new here" checked={choice?.kind === "new"} onPick={() => pick({ kind: "new" })} />
					{returning.length > 0 && (
						<OptionRadio
							title="I'm already in this group"
							checked={choice?.kind === "back"}
							onPick={() => pick({ kind: "back", memberId: returning.length === 1 ? returning[0].memberId : null })}
						/>
					)}
				</List>
			</FieldSet>

			{choice?.kind === "new" && (
				<Field
					label="Your name"
					htmlFor="join-name"
					error={clash ? `${name.trim()} is already in this group` : (error ?? undefined)}
				>
					<Input
						id="join-name"
						maxLength={60}
						autoComplete="given-name"
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setError(null);
						}}
					/>
				</Field>
			)}

			{choice?.kind === "back" && (
				<>
					<FieldSet legend="Your name">
						<List role="radiogroup" aria-label="Your name">
							{returning.map((p) => (
								<PersonRadio
									key={p.memberId}
									id={p.memberId}
									name={p.displayName}
									checked={choice.memberId === p.memberId}
									onPick={() => pick({ kind: "back", memberId: p.memberId })}
								/>
							))}
						</List>
					</FieldSet>
					<Field
						label="Your code"
						htmlFor="personal-code"
						hint="The code you got when you joined"
						error={error ?? undefined}
					>
						<Input
							id="personal-code"
							variant="code"
							autoCapitalize="characters"
							autoComplete="off"
							spellCheck={false}
							placeholder="7KQ-M2D"
							maxLength={9}
							value={personalCode}
							onChange={(e) => {
								setPersonalCode(e.target.value.toUpperCase());
								setError(null);
							}}
						/>
					</Field>
				</>
			)}

			{choice?.kind === "claim" && error && <p className="type-body-sm text-owe">{error}</p>}

			{signedIn ? (
				<JoinButton
					code={code}
					preview={preview}
					draft={draft}
					ready={ready}
					auto={!!restored && draftReady(restored)}
					busy={busy}
					setBusy={setBusy}
					onError={setError}
					onGone={onGone}
				/>
			) : account ? (
				<Card>
					<EmailSignIn onBack={() => setAccount(false)} />
				</Card>
			) : (
				<Stack>
					<Button
						size="lg"
						className="w-full"
						disabled={!ready}
						onClick={() => {
							stash(code, draft);
							setAccount(true);
						}}
					>
						Create an account
					</Button>
					<Button
						size="lg"
						variant="outline"
						className="w-full"
						disabled={!ready || busy}
						onClick={() => {
							stash(code, draft);
							setBusy(true);
							signInAsGuest().catch((e: unknown) => {
								toast.error("Couldn't continue as a guest", {
									description: e instanceof Error ? e.message : undefined,
								});
								setBusy(false);
							});
						}}
					>
						Continue as guest
					</Button>
				</Stack>
			)}
		</>
	);
}

function JoinButton({
	code,
	preview,
	draft,
	ready,
	auto,
	busy,
	setBusy,
	onError,
	onGone,
}: {
	code: string;
	preview: GroupPreview;
	draft: Draft;
	ready: boolean;
	// A choice made before signing in: join once without another tap.
	auto: boolean;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	onError: (message: string) => void;
	onGone: () => void;
}) {
	const user = useCurrentUser();
	const navigate = useNavigate();
	const started = useRef(false);
	const back = draft.choice?.kind === "back";

	async function join() {
		const { choice } = draft;
		if (!choice) return;
		setBusy(true);
		try {
			const groupId = await joinWithCode({
				code,
				claimMemberId: choice.kind === "new" ? undefined : (choice.memberId ?? undefined),
				displayName: choice.kind === "new" ? draft.name.trim() : undefined,
				personalCode: choice.kind === "back" ? (normaliseCode(draft.personalCode) ?? undefined) : undefined,
			});
			requestSync();
			const state: GuestCodeSheetState | null =
				user.isAnonymous && choice.kind !== "back" ? { showGuestCode: true } : null;
			navigate(`/groups/${groupId}`, { replace: true, state });
		} catch (error) {
			setBusy(false);
			const codeOf = error instanceof TransportError ? error.code : null;
			const message = error instanceof Error ? error.message : "";
			if (codeOf === "HS404") {
				toast.error(DOESNT_WORK);
				onGone();
			} else if (codeOf === "HS409" || codeOf === "HS422") onError(message);
			else if (codeOf === "23514") onError("That name is too long");
			else if (codeOf === "network") onError("Joining needs a connection.");
			else toast.error("Couldn't join", { description: message || undefined });
		}
	}

	useEffect(() => {
		if (auto && !started.current) {
			started.current = true;
			void join();
		}
		// Runs once, for the choice restored on mount.
	}, [auto]);

	return (
		<Button size="lg" disabled={busy || !ready} onClick={() => void join()}>
			{busy ? "Joining…" : back ? "Get back in" : `Join ${preview.groupName}`}
		</Button>
	);
}
