import { useCallback, useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditorDialog } from "@/components/editor-dialog";
import { MyGuestCodes } from "@/components/guest-code";
import { useOpenDebts } from "@/components/my-balances";
import { Notice } from "@/components/notices";
import { Screen, ScreenHeader, Section } from "@/components/screen";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { deleteMyAccount, signOut, useCurrentUser } from "@/lib/auth";
import { formatAmount } from "@/lib/money";
import { useOnline } from "@/lib/online";
import { describeDebt } from "@/lib/shell-view";
import {
	createApiToken,
	listApiTokens,
	revokeApiToken,
	TransportError,
	type ApiToken,
	type NewApiToken,
} from "@/lib/sync/supabase-transport";
import { byText } from "@/lib/utils";

const NEEDS_CONNECTION = "Needs a connection";

function shortDate(iso: string) {
	return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function problem(error: unknown) {
	return error instanceof TransportError && error.code === "network"
		? NEEDS_CONNECTION
		: error instanceof Error
			? error.message
			: undefined;
}

function ConnectedApps() {
	const online = useOnline();
	const [tokens, setTokens] = useState<ApiToken[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const [created, setCreated] = useState<NewApiToken | null>(null);
	const [revoking, setRevoking] = useState<ApiToken | null>(null);

	const load = useCallback(async () => {
		try {
			setTokens(await listApiTokens());
			setFailed(false);
		} catch {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		if (online) void load();
	}, [online, load]);

	async function create() {
		try {
			const made = await createApiToken(name.trim());
			setNaming(false);
			setName("");
			setCreated(made);
			void load();
		} catch (error) {
			toast.error("Couldn't connect the app", { description: problem(error) });
		}
	}

	async function revoke(token: ApiToken) {
		try {
			await revokeApiToken(token.id);
			setRevoking(null);
			void load();
		} catch (error) {
			toast.error("Couldn't revoke it", { description: problem(error) });
		}
	}

	async function copy(text: string) {
		let copied = false;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			// Falls back to selecting the text, for browsers that refuse the clipboard API.
			const field = document.createElement("textarea");
			field.value = text;
			field.style.position = "fixed";
			field.style.opacity = "0";
			document.body.appendChild(field);
			field.select();
			copied = document.execCommand("copy");
			field.remove();
		}
		if (copied) toast.success("Copied");
		else toast.error("Couldn't copy. Select the token and copy it by hand.");
	}

	const sorted = [...(tokens ?? [])].sort(byText((t) => t.name));

	return (
		<Section
			title="Connected apps"
			action={
				<Button size="sm" disabled={!online} onClick={() => setNaming(true)}>
					Connect an app
				</Button>
			}
		>
			{!online ? (
				<Notice tone="waiting">{NEEDS_CONNECTION}</Notice>
			) : failed ? (
				<Notice
					tone="waiting"
					action={
						<Button size="sm" variant="outline" onClick={() => void load()}>
							Try again
						</Button>
					}
				>
					Couldn't load your apps.
				</Notice>
			) : tokens && sorted.length === 0 ? (
				<p className="type-body text-muted-foreground">No apps connected. Connect one to let it read your balances.</p>
			) : (
				<List>
					{sorted.map((t) => (
						<ListRow
							key={t.id}
							title={t.name}
							subtitle={`Created ${shortDate(t.createdAt)} · ${t.lastUsedAt ? `Last used ${shortDate(t.lastUsedAt)}` : "Never used"}`}
							trailing={
								<Button size="sm" variant="outline" onClick={() => setRevoking(t)}>
									Revoke
								</Button>
							}
						/>
					))}
				</List>
			)}

			<EditorDialog
				open={naming}
				onOpenChange={setNaming}
				title="Connect an app"
				description="Name it so you know which app it is. It can read, never change."
				submitLabel="Create token"
				canSubmit={name.trim().length > 0 && online}
				onSubmit={create}
			>
				<Field label="Name" htmlFor="token-name" error={online ? undefined : NEEDS_CONNECTION}>
					<Input
						id="token-name"
						placeholder="Pholio"
						maxLength={60}
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
			</EditorDialog>

			<Dialog open={!!created} onOpenChange={(open) => !open && setCreated(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{created?.name} is connected</DialogTitle>
						<DialogDescription>Paste this token into the app. You won't see this again.</DialogDescription>
					</DialogHeader>
					<code className="type-body-sm break-all rounded-lg bg-sunken p-panel select-all">{created?.token}</code>
					<DialogFooter>
						<Button variant="outline" onClick={() => created && void copy(created.token)}>
							<Copy aria-hidden /> Copy
						</Button>
						<Button onClick={() => setCreated(null)}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={!!revoking}
				onOpenChange={(open) => !open && setRevoking(null)}
				title={`Revoke ${revoking?.name ?? "this app"}?`}
				description="It stops working at once. You can connect it again later."
				confirmLabel="Revoke"
				tone="destructive"
				onConfirm={() => (revoking ? revoke(revoking) : undefined)}
			/>
		</Section>
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

export function SettingsPage() {
	const user = useCurrentUser();

	return (
		<Screen>
			<ScreenHeader
				back={{ to: "/", label: "Groups" }}
				title="Settings"
				lead={user.isAnonymous ? "Guest" : user.email}
			/>
			{user.isAnonymous ? (
				<Section title="Your code">
					<MyGuestCodes className="type-body flex flex-col" />
					<p className="type-body-sm text-muted-foreground">Save it to get back in on another device.</p>
				</Section>
			) : (
				<>
					<ConnectedApps />
					<Button variant="outline" className="self-start" onClick={() => void signOut()}>
						Sign out
					</Button>
				</>
			)}
			<DeleteAccount />
		</Screen>
	);
}
