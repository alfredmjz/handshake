import { useEffect, useState, type ReactNode } from "react";
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
import { signInAsGuest, useCurrentUser } from "@/lib/auth";
import { codeKind, normaliseCode } from "@/lib/code-format";
import { draftReady, nameClash, type Choice, type Draft, type ReadyDraft } from "@/lib/join-draft";
import { createJoinFlow, type JoinPorts, type JoinResult } from "@/lib/join-flow";
import { useOnline } from "@/lib/online";
import { DOESNT_WORK, previewFailure } from "@/lib/online-outcome";
import { requestSync } from "@/lib/sync/controller";
import {
	joinWithCode,
	previewCode,
	returnWithCode,
	type CodePreview,
	type GroupPreview,
} from "@/lib/sync/supabase-transport";
import { byText } from "@/lib/utils";
import { EmailSignIn } from "@/pages/sign-in";

const ports: JoinPorts = { joinWithCode, returnWithCode, signInAsGuest, requestSync, storage: () => sessionStorage };

// Into the group, or the problem shown and the button given back.
function useShowResult(setBusy: (busy: boolean) => void, onError: (message: string) => void, onGone: () => void) {
	const navigate = useNavigate();
	return (result: JoinResult | null) => {
		if (!result) return;
		if (result.kind === "in") {
			const state: GuestCodeSheetState | null = result.showGuestCode ? { showGuestCode: true } : null;
			return void navigate(`/groups/${result.groupId}`, { replace: true, state });
		}
		setBusy(false);
		if (result.kind === "gone") {
			toast.error(result.title);
			onGone();
		} else if (result.kind === "inline") onError(result.message);
		else toast.error(result.title, { description: result.description });
	};
}

// Finishes once, on mount, what was chosen before signing in. StrictMode runs effects twice: go() hands back the
// attempt in flight, and only the live run shows its result.
function useResume(start: (() => Promise<JoinResult>) | null, show: (result: JoinResult) => void) {
	useEffect(() => {
		if (!start) return;
		let cancelled = false;
		void start().then((result) => cancelled || show(result));
		return () => void (cancelled = true);
	}, [!!start]);
}

// Opening the code of a group you're in takes you straight into it; a screen saying so would be a dead end.
function AlreadyIn({ groupId, groupName }: { groupId: string; groupName: string }) {
	const navigate = useNavigate();
	useEffect(() => {
		toast(`You're already in ${groupName}`);
		navigate(`/groups/${groupId}`, { replace: true });
	}, [groupId, groupName, navigate]);
	return null;
}

type Loaded = { code: string } & ({ preview: CodePreview } | { error: "gone" | "failed" });

function usePreview(code: string | null, online: boolean) {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		if (!code || !online) return;
		let cancelled = false;
		previewCode(code).then(
			(preview) => !cancelled && setLoaded({ code, preview }),
			(error) => !cancelled && setLoaded({ code, error: previewFailure(error) })
		);
		return () => {
			cancelled = true;
		};
	}, [code, online]);
	return loaded && loaded.code === code ? loaded : null;
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

// /join/:code (a group code, a guest's personal code, or anything normaliseCode reads). A group code: signed
// out you choose who you are, then an account or guest; the URL stays, so you land back here and the join
// finishes. A personal code goes straight back in as that guest.
export function JoinPage({ signedIn }: { signedIn: boolean }) {
	const params = useParams();
	const code = normaliseCode(params.code ?? "");
	const online = useOnline();
	const loaded = usePreview(code, online);
	const [gone, setGone] = useState(false);

	let body: ReactNode = null;
	if (!code || gone || (loaded && "error" in loaded && loaded.error === "gone")) {
		// A personal code that doesn't work has no one else to ask; a group's code can be asked for again.
		const personal = code !== null && codeKind(code) === "personal";
		body = <EmptyState title={personal ? `${DOESNT_WORK}.` : `${DOESNT_WORK}. Ask for the group's code again.`} />;
	} else if (!online) {
		body = <EmptyState kind="shake" title="Joining needs a connection." />;
	} else if (loaded && "error" in loaded) {
		body = <EmptyState title="Couldn't open this code. Try again in a moment." />;
	} else if (loaded) {
		const { preview } = loaded;
		body =
			preview.kind === "personal" ? (
				<PersonalReturn
					key={loaded.code}
					code={loaded.code}
					preview={preview}
					signedIn={signedIn}
					onGone={() => setGone(true)}
				/>
			) : signedIn ? (
				<SignedInJoinChoice key={loaded.code} code={loaded.code} preview={preview} onGone={() => setGone(true)} />
			) : (
				<JoinChoice key={loaded.code} code={loaded.code} preview={preview} onGone={() => setGone(true)} />
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
	return <JoinChoice {...props} signedIn guest={user.isAnonymous} defaultName={user.isAnonymous ? "" : user.name} />;
}

function JoinChoice({
	code,
	preview,
	onGone,
	signedIn = false,
	guest = false,
	defaultName = "",
}: ChoiceProps & { signedIn?: boolean; guest?: boolean; defaultName?: string }) {
	const [flow] = useState(() => createJoinFlow(ports, code));
	const [restored] = useState(() => (signedIn ? flow.restore().draft : null));
	const [choice, setChoice] = useState<Choice | null>(
		restored?.choice ?? (preview.unclaimed.length === 0 && preview.returning.length === 0 ? { kind: "new" } : null)
	);
	const [name, setName] = useState(restored?.name || defaultName);
	const [personalCode, setPersonalCode] = useState(restored?.personalCode ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [account, setAccount] = useState(false);
	const show = useShowResult(setBusy, setError, onGone);

	const unclaimed = [...preview.unclaimed].sort(byText((p) => p.displayName));
	const returning = [...preview.returning].sort(byText((p) => p.displayName));
	const draft: Draft = { choice, name, personalCode };
	const clash = nameClash(draft, preview);
	const ready = draftReady(draft) && !clash;

	function join(ready: ReadyDraft) {
		setBusy(true);
		return flow.go({ kind: "join", draft: ready }, guest);
	}

	// A choice made before signing in: join once without another tap.
	useResume(restored && draftReady(restored) && !preview.alreadyMember ? () => join(restored) : null, show);

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
							placeholder="7KQM-2DXH"
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
				<Button size="lg" disabled={busy || !ready} onClick={() => ready && void join(draft).then(show)}>
					{busy ? "Joining…" : choice?.kind === "back" ? "Get back in" : `Join ${preview.groupName}`}
				</Button>
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
							if (ready) flow.stash({ kind: "join", draft });
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
							if (!ready) return;
							setBusy(true);
							void flow.viaGuest({ kind: "join", draft }).then(show);
						}}
					>
						Continue as guest
					</Button>
				</Stack>
			)}
		</>
	);
}

type PersonalPreview = Extract<CodePreview, { kind: "personal" }>;

// A personal code: "Welcome back, Gus" and one button, straight into the group under that name.
function PersonalReturn({
	code,
	preview,
	signedIn,
	onGone,
}: {
	code: string;
	preview: PersonalPreview;
	signedIn: boolean;
	onGone: () => void;
}) {
	const [flow] = useState(() => createJoinFlow(ports, code));
	const [auto] = useState(() => signedIn && flow.restore().returning);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const show = useShowResult(setBusy, setError, onGone);

	function getBackIn() {
		setBusy(true);
		setError(null);
		return flow.go({ kind: "return" });
	}

	useResume(auto && !preview.alreadyMember ? getBackIn : null, show);

	if (signedIn && preview.alreadyMember) return <AlreadyIn groupId={preview.groupId} groupName={preview.groupName} />;

	return (
		<>
			<ScreenHeader eyebrow={preview.groupName} title={`Welcome back, ${preview.displayName}`} />
			{error && <p className="type-body-sm text-owe">{error}</p>}
			{signedIn ? (
				<Button size="lg" disabled={busy} onClick={() => void getBackIn().then(show)}>
					{busy ? "Joining…" : "Get back in"}
				</Button>
			) : (
				<Button
					size="lg"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void flow.viaGuest({ kind: "return" }).then(show);
					}}
				>
					Continue as guest
				</Button>
			)}
		</>
	);
}
