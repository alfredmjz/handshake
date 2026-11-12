import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditorDialog } from "@/components/editor-dialog";
import { NameDialog } from "@/components/group/name-dialog";
import { MyGuestCodes } from "@/components/guest-code";
import { useOpenDebts } from "@/components/my-balances";
import { Notice } from "@/components/notices";
import { Screen, ScreenHeader, Section } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { changeName, deleteMyAccount, finishEmailChange, startEmailChange, useCurrentUser } from "@/lib/auth";
import { useCommit } from "@/lib/changes";
import { myOpenMemberships } from "@/lib/members";
import { formatAmount } from "@/lib/money";
import { useOnline } from "@/lib/online";
import { describeDebt } from "@/lib/shell-view";
import { TransportError } from "@/lib/sync/supabase-transport";

const NEEDS_CONNECTION = "Needs a connection";

function problem(error: unknown) {
	return error instanceof TransportError && error.code === "network"
		? NEEDS_CONNECTION
		: error instanceof Error
			? error.message
			: undefined;
}

function listOf(names: string[]) {
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Your name, kept on the account for groups from now on, and changed in each open group you're in.
function NameRow() {
	const user = useCurrentUser();
	const online = useOnline();
	const commit = useCommit();
	const [open, setOpen] = useState(false);

	async function save(name: string) {
		try {
			await changeName(name);
		} catch (error) {
			toast.error("Couldn't change your name", { description: problem(error) });
			return false;
		}
		const kept: string[] = [];
		for (const m of await myOpenMemberships(user.id)) {
			if (m.displayName === name) continue;
			const plan = await commit({ type: "renamePerson", groupId: m.groupId, memberId: m.memberId, displayName: name });
			if (!plan.ok) kept.push(m.groupName);
		}
		if (kept.length > 0)
			toast.success("Name changed", {
				description: `${listOf(kept)} kept your old name: someone there already goes by ${name}.`,
			});
		else toast.success("Name changed");
		return true;
	}

	return (
		<>
			<ListRow
				title={user.name}
				subtitle="Name"
				trailing={
					<Button size="sm" variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
						Change
					</Button>
				}
			/>
			<NameDialog
				open={open}
				onOpenChange={setOpen}
				title="Your name"
				submitLabel="Save name"
				initial={user.name}
				onSave={save}
			/>
		</>
	);
}

// Moving the account to another email: a code to the new address, and one to the current address so both agree.
function EmailRow() {
	const user = useCurrentUser();
	const online = useOnline();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"email" | "codes">("email");
	const [email, setEmail] = useState("");
	const [currentCode, setCurrentCode] = useState("");
	const [newCode, setNewCode] = useState("");
	const [busy, setBusy] = useState(false);

	const reset = (next: boolean) => {
		setOpen(next);
		if (next) return;
		setStep("email");
		setEmail("");
		setCurrentCode("");
		setNewCode("");
	};
	const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && email.trim().toLowerCase() !== user.email.toLowerCase();
	const codesIn = /^\d{6}$/.test(currentCode.trim()) && /^\d{6}$/.test(newCode.trim());

	async function submit() {
		setBusy(true);
		try {
			if (step === "email") {
				if ((await startEmailChange(email)) === "code-sent") setStep("codes");
				else {
					toast.success("Email changed");
					reset(false);
				}
			} else {
				await finishEmailChange({ currentEmail: user.email, currentCode, newEmail: email, newCode });
				toast.success("Email changed", { description: `Sign in with ${email.trim()} from now on.` });
				reset(false);
			}
		} catch (error) {
			toast.error(step === "email" ? "Couldn't send the codes" : "That didn't work", { description: problem(error) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<ListRow
				title={user.email}
				subtitle="Email"
				trailing={
					<Button size="sm" variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
						Change
					</Button>
				}
			/>
			<EditorDialog
				open={open}
				onOpenChange={reset}
				title="Your email"
				description={
					step === "email" ? "You'll sign in with the new one." : "Each address got a 6-digit code. Enter both."
				}
				submitLabel={busy ? "Working…" : step === "email" ? "Send codes" : "Change email"}
				canSubmit={online && !busy && (step === "email" ? valid : codesIn)}
				onSubmit={submit}
			>
				{step === "email" ? (
					<Field label="New email" htmlFor="new-email" error={online ? undefined : NEEDS_CONNECTION}>
						<Input
							id="new-email"
							type="email"
							autoComplete="email"
							autoFocus
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</Field>
				) : (
					<>
						<Field label={`Code sent to ${user.email}`} htmlFor="current-code">
							<Input
								id="current-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={6}
								autoFocus
								value={currentCode}
								onChange={(e) => setCurrentCode(e.target.value)}
							/>
						</Field>
						<Field label={`Code sent to ${email.trim()}`} htmlFor="new-code">
							<Input
								id="new-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={6}
								value={newCode}
								onChange={(e) => setNewCode(e.target.value)}
							/>
						</Field>
					</>
				)}
			</EditorDialog>
		</>
	);
}

function DeleteAccount() {
	const online = useOnline();
	const debts = useOpenDebts();
	const [open, setOpen] = useState(false);

	async function remove() {
		try {
			await deleteMyAccount();
		} catch (error) {
			setOpen(false);
			toast.error("Couldn't delete your account", { description: problem(error) });
		}
	}

	return (
		<Section title="Delete account">
			<p className="type-body text-muted-foreground">
				Your groups keep your name on everything you added, so the numbers still add up.
			</p>
			{!online && <Notice tone="waiting">{NEEDS_CONNECTION}</Notice>}
			<Button variant="outline" className="self-start" disabled={!online} onClick={() => setOpen(true)}>
				<Trash2 aria-hidden /> Delete account
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Delete your account?"
				description={
					<>
						<p>This can't be undone. Everything on this device goes too.</p>
						{debts && debts.length > 0 && (
							<ul className="flex flex-col gap-1">
								{debts.map((d, i) => (
									<li key={i} className="type-body-sm">
										{describeDebt({ ...d }, (cents) => formatAmount(cents))}
									</li>
								))}
							</ul>
						)}
					</>
				}
				confirmLabel="Delete account"
				tone="destructive"
				onConfirm={remove}
			/>
		</Section>
	);
}

// Your name, your email, and deleting the account. A guest has no email yet; their code is how they get back in.
export function SettingsPage() {
	const user = useCurrentUser();
	const online = useOnline();

	return (
		<Screen>
			<ScreenHeader back={{ to: "/", label: "Groups" }} title="Settings" />
			{!online && <Notice tone="waiting">{NEEDS_CONNECTION} to change these</Notice>}
			<Section title="You">
				<List>
					<NameRow />
					{!user.isAnonymous && <EmailRow />}
				</List>
			</Section>
			{user.isAnonymous && (
				<Section title="Your code">
					<MyGuestCodes className="type-body flex flex-col" />
					<p className="type-body-sm text-muted-foreground">Save it to get back in on another device.</p>
				</Section>
			)}
			<DeleteAccount />
		</Screen>
	);
}
