import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

import { HandshakeMark, ReceiptDoodle } from "@/components/art/doodles";
import { Hand, type HandKind } from "@/components/art/hand";
import { Underlined } from "@/components/art/marks";
import { CodeInput } from "@/components/code-input";
import { JoinCodeForm } from "@/components/join-code-form";
import { Notice } from "@/components/notices";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Stack } from "@/components/ui/stack";
import { takeEndedNotice } from "@/lib/auth";
import { CODE_LENGTH } from "@/lib/emailed-code";
import { emailLinkIn } from "@/lib/email-link";
import { devLoginAvailable, switchToTestAccount, TEST_ACCOUNTS } from "@/lib/dev-login";
import { failureNotice, OFFLINE_SIGN_IN } from "@/lib/online-outcome";
import { formatCountdown, useSecondsUntilResend } from "@/lib/resend-cooldown";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

const RING: HandKind[] = ["drinks", "food", "travel", "stay", "fun", "groceries"];

// Six hands around a receipt: everyone in the group, passing the bill.
function HandsAroundReceipt() {
	return (
		<div aria-hidden className="relative mx-auto size-66 sm:size-76">
			<div className="absolute left-1/2 top-1/2 size-0 sm:scale-110">
				{RING.map((kind, i) => (
					<div
						key={kind}
						className="absolute -left-12.5 top-0 size-25"
						style={{ transformOrigin: "50% 0", transform: `rotate(${i * 60}deg) translateY(1rem)` }}
					>
						<Hand kind={kind} size={100} blob />
					</div>
				))}
				<ReceiptDoodle className="absolute -left-7 top-[-2.2rem] w-14 rotate-[-8deg]" />
			</div>
		</div>
	);
}

// Email, then the emailed code. Also shown from a group code, so someone signed out can make an account.
export function EmailSignIn({ onBack }: { onBack?: () => void }) {
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [step, setStep] = useState<"email" | "code">("email");
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState<{ email: string; at: number } | null>(null);
	const address = email.trim().toLowerCase();
	const wait = useSecondsUntilResend(sent?.email === address ? sent.at : null);

	async function send(): Promise<boolean> {
		if (!navigator.onLine) {
			toast.error(OFFLINE_SIGN_IN.title, { description: OFFLINE_SIGN_IN.description });
			return false;
		}
		setBusy(true);
		const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
		setBusy(false);
		if (error) {
			toast.error(...failureNotice(error, "Couldn't send the code"));
			return false;
		}
		setSent({ email: address, at: Date.now() });
		return true;
	}

	// Back to the same address within the minute: its code is still on the way, so straight to it.
	async function sendCode(event: FormEvent) {
		event.preventDefault();
		if (wait > 0 || (await send())) setStep("code");
	}

	// A new code replaces the last one, so the box starts empty.
	async function resend() {
		if (!(await send())) return;
		setCode("");
		toast.success("New code sent", { description: "Use the newest email." });
	}

	async function verify(token: string) {
		setBusy(true);
		const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: "email" });
		setBusy(false);
		if (error) toast.error(...failureNotice(error, "That code didn't work"));
	}

	return (
		<div>
			{step === "email" ? (
				<form onSubmit={sendCode}>
					<Stack>
						<Field label="Email" htmlFor="email">
							<Input
								id="email"
								type="email"
								autoComplete="email"
								required
								autoFocus
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</Field>
						<Button type="submit" size="lg" className="w-full" disabled={busy || !email.trim()}>
							{busy ? "Sending…" : wait > 0 ? "Enter the code" : "Send code"}
						</Button>
						{onBack && (
							<Button type="button" variant="ghost" className="w-full" onClick={onBack}>
								Back
							</Button>
						)}
					</Stack>
				</form>
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void verify(code);
					}}
				>
					<Stack>
						<Field label="Code" htmlFor="code" hint={`We sent a code to ${email.trim()}.`}>
							<CodeInput
								id="code"
								autoFocus
								value={code}
								onChange={setCode}
								onComplete={(complete) => void verify(complete)}
								ready={!busy}
							/>
						</Field>
						<Button type="submit" size="lg" className="w-full" disabled={busy || code.length < CODE_LENGTH}>
							{busy ? "Checking…" : "Sign in"}
						</Button>
						<Button
							type="button"
							variant="outline"
							className="w-full tabular-nums"
							disabled={busy || wait > 0}
							onClick={() => void resend()}
						>
							{wait > 0 ? `Resend code in ${formatCountdown(wait)}` : "Resend code"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="w-full"
							onClick={() => {
								setCode("");
								setStep("email");
							}}
						>
							Use a different email
						</Button>
					</Stack>
				</form>
			)}
		</div>
	);
}

const linksTried = new Set<string>();

// Opened from the sign-in email's button. Once signed in, the app moves on to the groups by itself; a link that no
// longer works goes back to the front door with a note.
export function EmailLinkSignIn() {
	const navigate = useNavigate();
	const { search } = useLocation();

	useEffect(() => {
		const link = emailLinkIn(search);
		if (!link) {
			navigate("/", { replace: true });
			return;
		}
		if (linksTried.has(link.tokenHash)) return;
		linksTried.add(link.tokenHash);
		if (!navigator.onLine) {
			linksTried.delete(link.tokenHash);
			toast.error(OFFLINE_SIGN_IN.title, { description: OFFLINE_SIGN_IN.description });
			navigate("/", { replace: true });
			return;
		}
		void supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type }).then(({ error }) => {
			if (!error) return;
			toast.error(...failureNotice(error, "That link didn't work"));
			navigate("/", { replace: true });
		});
	}, [navigate, search]);

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-stack px-page">
			<HandshakeMark className="h-8 w-12" />
			<p className="type-body text-muted-foreground">Signing you in…</p>
		</div>
	);
}

// Local development only: straight in as one of the test accounts, no emailed code.
function TestAccountLinks() {
	const [busy, setBusy] = useState(false);
	return (
		<p className="type-label flex flex-wrap items-center justify-center gap-x-stack gap-y-1 text-primary-foreground/70">
			<span>Test account (local):</span>
			{TEST_ACCOUNTS.map((account) => (
				<Button
					key={account.id}
					variant="link"
					size="inline"
					className="type-label text-primary-foreground/85 hover:text-primary-foreground"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await switchToTestAccount(account.id);
						} catch (error) {
							toast.error("Couldn't sign in", { description: (error as Error).message });
						}
						setBusy(false);
					}}
				>
					{account.label}
				</Button>
			))}
		</p>
	);
}

// The signed-out front door: hands passing a receipt, and a cobalt sheet that asks for an email or a group code.
export function SignInPage() {
	const [view, setView] = useState<"welcome" | "email" | "code">("welcome");
	const [ended] = useState(takeEndedNotice);

	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col lg:flex-row lg:items-center lg:gap-x-spread lg:px-page">
			<div className="flex flex-1 flex-col">
				<header className="flex items-center gap-control px-page pt-[max(var(--space-section),env(safe-area-inset-top))] lg:px-0 lg:pt-0">
					<HandshakeMark className="h-8 w-12" />
					<span className="type-wordmark">handshake</span>
				</header>
				<div className="flex flex-1 items-center justify-center py-section">
					<HandsAroundReceipt />
				</div>
			</div>
			<section
				className={cn(
					"flex min-h-91.5 flex-col gap-stack rounded-t-sheet px-page pb-section pt-section lg:min-h-0 lg:flex-1 lg:rounded-sheet lg:px-12 lg:py-12",
					view === "welcome" ? "bg-primary text-primary-foreground" : "bg-raised text-foreground"
				)}
			>
				{view === "welcome" ? (
					<>
						{ended && <Notice className="text-ink">{ended}</Notice>}
						<h1 className="type-display text-balance">
							<Underlined delay={0.6} tone="waiting">
								Who owes who?
							</Underlined>
						</h1>
						<p className="type-body-lg max-w-76 text-primary-foreground/85">
							Split costs with friends, see where everyone stands, and settle up in a tap.
						</p>
						<div className="flex-1" />
						<Button variant="inverse" size="lg" className="w-full" onClick={() => setView("email")}>
							Get started
						</Button>
						<Button
							variant="link"
							size="inline"
							className="self-center text-primary-foreground hover:text-primary-foreground/80"
							onClick={() => setView("code")}
						>
							Have a code?
						</Button>
						{import.meta.env.DEV && devLoginAvailable() && <TestAccountLinks />}
					</>
				) : view === "email" ? (
					<>
						<h1 className="type-h2">Sign in</h1>
						<EmailSignIn onBack={() => setView("welcome")} />
					</>
				) : (
					<>
						<h1 className="type-h2">Join a group</h1>
						<JoinCodeForm autoFocus>
							<Button type="button" variant="ghost" className="w-full" onClick={() => setView("welcome")}>
								Back
							</Button>
						</JoinCodeForm>
					</>
				)}
			</section>
		</div>
	);
}
