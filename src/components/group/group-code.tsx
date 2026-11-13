import { useState } from "react";
import { Link2, Share2 } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { copyText, CopyButton } from "@/components/copy-button";
import type { GroupData } from "@/components/group/group-data";
import { useRun } from "@/components/group/use-run";
import { Section } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Inline } from "@/components/ui/stack";
import { formatCode, joinPath } from "@/lib/code-format";
import { useGroupCode } from "@/lib/codes";
import { joinedSummary } from "@/lib/shell-view";
import { byText } from "@/lib/utils";

export function joinUrl(code: string): string {
	return `${location.origin}${joinPath(code)}`;
}

// "3 joined · Ann, Jo and Sam"; with more than three, hovering or tapping lists everyone. Said once: when the
// group is only you, the People tab already says it above.
function Joined({ names, alone }: { names: string[]; alone: boolean }) {
	const [open, setOpen] = useState(false);
	if (names.length === 0)
		return alone ? null : <p className="type-body-sm text-muted-foreground">No one has joined yet</p>;
	const line = `${names.length} joined · ${joinedSummary(names)}`;
	if (names.length <= 3) return <p className="type-body-sm text-muted-foreground">{line}</p>;
	const everyone = [...names].sort(byText((n) => n));
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="type-body-sm self-start text-left text-muted-foreground underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onMouseEnter={() => setOpen(true)}
					onMouseLeave={() => setOpen(false)}
				>
					{line}
				</button>
			</PopoverTrigger>
			<PopoverContent onOpenAutoFocus={(e) => e.preventDefault()}>
				<ul aria-label="Everyone who joined" className="flex flex-col gap-1">
					{everyone.map((name, i) => (
						<li key={`${name}-${i}`}>{name}</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

// The group's code for owners and members: the code, Copy, the link, Share, the owner's Reset code, and who
// joined. A group not synced yet has no code.
export function GroupCode({ data, alone = false }: { data: GroupData; alone?: boolean }) {
	const run = useRun();
	const groupId = data.group?.id ?? "";
	const code = useGroupCode(groupId);
	const [confirming, setConfirming] = useState(false);
	const completed = !!data.group?.completedAt;
	const joined = data.active.filter((m) => m.userId !== null && m.role !== "owner").map((m) => m.displayName);
	const share = typeof navigator !== "undefined" && typeof navigator.share === "function";

	return (
		<Section
			title="Group code"
			action={
				data.can("group.recode") &&
				code && (
					<Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
						Reset code
					</Button>
				)
			}
		>
			{code === undefined ? null : code === null ? (
				<p className="type-body-sm text-muted-foreground">Code appears once synced</p>
			) : (
				<Inline gap="control" wrap={false} className="min-w-0">
					<span className="type-h2 tracking-[0.12em]" data-testid="group-code">
						{formatCode(code)}
					</span>
					<Inline gap="none" wrap={false}>
						<CopyButton text={formatCode(code)} label="Copy code" done="Code copied" disabled={completed} />
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Copy link"
							title="Copy link"
							disabled={completed}
							onClick={() => void copyText(joinUrl(code), "Link copied")}
						>
							<Link2 />
						</Button>
						{share && (
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="Share"
								title="Share"
								disabled={completed}
								onClick={() =>
									void navigator
										.share({
											title: data.group?.name,
											text: `Join ${data.group?.name} on Handshake`,
											url: joinUrl(code),
										})
										.catch(() => {})
								}
							>
								<Share2 />
							</Button>
						)}
					</Inline>
				</Inline>
			)}
			{completed && code && <p className="type-body-sm text-muted-foreground">No one can join while it's completed</p>}
			<Joined names={joined} alone={alone} />
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Reset the code?"
				description="The old code stops working."
				confirmLabel="Reset code"
				onConfirm={async () => {
					await run({ type: "resetGroupCode", groupId });
				}}
			/>
		</Section>
	);
}
