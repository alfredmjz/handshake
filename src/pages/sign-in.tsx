import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { HandshakeMark, ReceiptDoodle } from "@/components/art/doodles";
import { Hand, type HandKind } from "@/components/art/hand";
import { Underlined } from "@/components/art/marks";
import { JoinCodeForm } from "@/components/join-code-form";
import { Notice } from "@/components/notices";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Stack } from "@/components/ui/stack";
import { takeEndedNotice } from "@/lib/auth";
import { devLoginAvailable, switchToTestAccount, TEST_ACCOUNTS } from "@/lib/dev-login";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

const RING: HandKind[] = ["drinks", "food", "travel", "stay", "fun", "groceries"];

// Six hands around a receipt: everyone in the group, passing the bill.
function HandsAroundReceipt() {
	return (
		<div aria-hidden className="relative mx-auto size-[16.5rem] sm:size-[19rem]">
			<div className="absolute left-1/2 top-1/2 size-0 sm:scale-110">
				{RING.map((kind, i) => (
					<div
						key={kind}
						className="absolute left-[-3.125rem] top-0 size-[6.25rem]"
						style={{ transformOrigin: "50% 0", transform: `rotate(${i * 60}deg) translateY(1rem)` }}
					>
						<Hand kind={kind} size={100} blob />
					</div>
				))}
				<ReceiptDoodle className="absolute left-[-1.75rem] top-[-2.2rem] w-14 -rotate-[8deg]" />
			</div>
		</div>
	);
}

// Email, then the 6-digit code. Also shown from a group code, so someone signed out can make an account.
export function EmailSignIn({ onBack }: { onBack?: () => void }) {
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [step, setStep] = useState<"email" | "code">("email");
	const [busy, setBusy] = useState(false);

	async function sendCode(event: FormEvent) {
		event.preventDefault();
		if (!navigator.onLine) {
			toast.error("You're offline", { description: "Signing in needs a connection." });
			return;
		}
		setBusy(true);
		const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
		setBusy(false);
		if (error) {
			toast.error("Couldn't send the code", { description: error.message });
			return;
		}
		setStep("code");
	}

	async function verifyCode(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
		setBusy(false);
		if (error) toast.error("That code didn't work", { description: error.message });
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
							{busy ? "Sending…" : "Send code"}
						</Button>
						{onBack && (
							<Button type="button" variant="ghost" className="w-full" onClick={onBack}>
								Back
							</Button>
						)}
					</Stack>
				</form>
			) : (
				<form onSubmit={verifyCode}>
					<Stack>
						<Field label="Code" htmlFor="code" hint={`We sent a 6-digit code to ${email.trim()}.`}>
							<Input
								id="code"
								variant="code"
								inputMode="numeric"
								autoComplete="one-time-code"
								placeholder="000000"
								required
								autoFocus
								maxLength={10}
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
							/>
						</Field>
						<Button type="submit" size="lg" className="w-full" disabled={busy || code.length < 6}>
							{busy ? "Checking…" : "Sign in"}
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
					"flex min-h-[22.875rem] flex-col gap-stack rounded-t-sheet px-page pb-section pt-section lg:min-h-0 lg:flex-1 lg:rounded-sheet lg:px-12 lg:py-12",
					view === "welcome" ? "bg-primary text-primary-foreground" : "bg-raised text-foreground"
				)}
			>
				{view === "welcome" ? (
					<>
						{ended && <Notice className="text-ink">{ended}</Notice>}
						<h1 className="type-display text-balance">
							Who owes who,{" "}
							<Underlined delay={0.6} tone="waiting">
								sorted.
							</Underlined>
						</h1>
						<p className="type-body-lg max-w-[19rem] text-primary-foreground/85">
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
