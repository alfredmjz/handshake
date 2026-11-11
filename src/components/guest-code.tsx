import { CopyButton } from "@/components/copy-button";
import { formatCode } from "@/lib/code-format";
import { useMyGuestCode } from "@/lib/codes";
import { useGroups } from "@/lib/groups";

function GroupGuestCode({ groupId, groupName, named }: { groupId: string; groupName: string; named: boolean }) {
	const code = useMyGuestCode(groupId);
	if (!code) return null;
	return (
		<li className="flex flex-wrap items-center gap-x-control gap-y-1">
			<span className="type-label text-muted-foreground">{named ? groupName : "Your code"}</span>
			{/* A ticket tag, tilted like the amount tags, so the code reads as something to keep. */}
			<span className="type-money -rotate-2 whitespace-nowrap rounded-md border-[1.5px] border-ink bg-paper px-2 py-0.5 tracking-[0.08em]">
				{formatCode(code)}
			</span>
			<CopyButton text={formatCode(code)} label="Copy your code" done="Code copied" />
		</li>
	);
}

// A guest's personal code, one line per group they're a guest in (named when there's more than one), with
// Copy: what gets them back in on another device.
export function MyGuestCodes({ className }: { className?: string }) {
	const groups = useGroups();
	if (!groups || groups.length === 0) return null;
	return (
		<ul className={className} aria-label="Your codes to get back in">
			{groups.map((g) => (
				<GroupGuestCode key={g.id} groupId={g.id} groupName={g.name} named={groups.length > 1} />
			))}
		</ul>
	);
}
