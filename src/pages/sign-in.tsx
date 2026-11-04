import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";

export function SignInPage() {
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
		<div className="flex min-h-dvh items-center justify-center px-4 py-10">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>Handshake</CardTitle>
					<CardDescription>
						{step === "email"
							? "Keep track of who owes who, and plan trips together."
							: `We sent a 6-digit code to ${email.trim()}.`}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{step === "email" ? (
						<form onSubmit={sendCode} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									autoComplete="email"
									required
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
							</div>
							<Button type="submit" className="w-full" disabled={busy || !email.trim()}>
								{busy ? "Sending…" : "Send code"}
							</Button>
						</form>
					) : (
						<form onSubmit={verifyCode} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="code">Code</Label>
								<Input
									id="code"
									inputMode="numeric"
									autoComplete="one-time-code"
									required
									maxLength={10}
									value={code}
									onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
								/>
							</div>
							<Button type="submit" className="w-full" disabled={busy || code.length < 6}>
								{busy ? "Checking…" : "Sign in"}
							</Button>
							<Button
								type="button"
								variant="link"
								className="w-full"
								onClick={() => {
									setCode("");
									setStep("email");
								}}
							>
								Use a different email
							</Button>
						</form>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
