import { useState } from "react";
import { toast } from "sonner";

import { EditorDialog } from "@/components/editor-dialog";
import { MyGuestCodes } from "@/components/guest-code";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { finishKeepMyData, startKeepMyData } from "@/lib/auth";
import { useOnline } from "@/lib/online";
import { requestSync } from "@/lib/sync/controller";
import { TransportError } from "@/lib/sync/supabase-transport";

// Shown on every screen for a guest: their data goes when a group completes, unless they add an email; and
// their personal code, to get back in on another device.
export function GuestBanner() {
	const online = useOnline();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"email" | "code">("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);

	function close(next: boolean) {
		setOpen(next);
		if (!next) {
			setStep("email");
			setCode("");
		}
	}

	function kept() {
		requestSync();
		toast.success("Your data is kept");
		close(false);
	}

	function failed(title: string, error: unknown) {
		toast.error(title, { description: error instanceof Error ? error.message : undefined });
	}

	async function submit() {
		setBusy(true);
		try {
			if (step === "email") {
				if ((await startKeepMyData(email)) === "done") kept();
				else setStep("code");
			} else {
				await finishKeepMyData(email, code);
				kept();
			}
		} catch (error) {
			failed(
				step === "email"
					? "Couldn't send the code"
					: error instanceof TransportError
						? "Couldn't keep your data"
						: "That code didn't work",
				error
			);
		} finally {
			setBusy(false);
		}
	}

	const ready = online && !busy && (step === "email" ? email.trim().includes("@") : code.length >= 6);

	return (
		<>
			<section
				aria-label="You're a guest"
				className="mb-stack grid gap-x-stack gap-y-control rounded-lg border-[1.5px] border-ink/15 bg-waiting/25 px-panel py-row sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
			>
				<div className="flex min-w-0 flex-col gap-control">
					<p className="type-body-sm">
						<span className="font-semibold">You're a guest.</span> Add your email to keep your groups after they're
						completed.
					</p>
					<MyGuestCodes className="flex flex-col gap-1" />
				</div>
				<Button size="sm" variant="outline" className="justify-self-start bg-paper" onClick={() => setOpen(true)}>
					Keep my data
				</Button>
			</section>
			<EditorDialog
				open={open}
				onOpenChange={close}
				title={step === "email" ? "Keep my data" : "Enter the code"}
				description={
					step === "email" ? "Add your email and your groups stay yours." : `We sent a 6-digit code to ${email.trim()}.`
				}
				submitLabel={busy ? "Checking…" : step === "email" ? "Send code" : "Keep my data"}
				canSubmit={ready}
				onSubmit={submit}
				secondary={
					step === "code" ? (
						<Button type="button" variant="ghost" onClick={() => setStep("email")}>
							Use a different email
						</Button>
					) : undefined
				}
			>
				{step === "email" ? (
					<Field label="Email" htmlFor="keep-email" error={online ? undefined : "Needs a connection"}>
						<Input
							id="keep-email"
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</Field>
				) : (
					<Field label="Code" htmlFor="keep-code" error={online ? undefined : "Needs a connection"}>
						<Input
							id="keep-code"
							variant="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							placeholder="000000"
							maxLength={10}
							value={code}
							onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
						/>
					</Field>
				)}
			</EditorDialog>
		</>
	);
}
