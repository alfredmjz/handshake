import { CopyButton } from "@/components/copy-button";
import { formatCode } from "@/lib/code-format";
import { useMyGuestCode } from "@/lib/codes";
import { useGroups } from "@/lib/groups";

function GroupGuestCode({ groupId, groupName, named }: { groupId: string; groupName: string; named: boolean }) {
	const code = useMyGuestCode(groupId);
	if (!code) return null;
	return (
		<li className="flex items-center gap-control">
			<span className="min-w-0">
				{named ? `${groupName}: ` : "Your code is "}
				<span className="whitespace-nowrap font-semibold tracking-[0.08em]">{formatCode(code)}</span>
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
