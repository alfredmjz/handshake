import { Link } from "react-router";

import { Face } from "@/components/art/face";
import type { GroupData } from "@/components/group/group-data";
import { Amount } from "@/components/money";
import { byText } from "@/lib/utils";

// Beside the notebook on wide screens: each debt between you and someone, a tap from the Balances tab.
export function BetweenYou({ data }: { data: GroupData }) {
	const me = data.me?.id;
	const mine = (data.summary?.debts ?? [])
		.filter((d) => d.fromMemberId === me || d.toMemberId === me)
		.map((d) => {
			const other = d.fromMemberId === me ? d.toMemberId : d.fromMemberId;
			return { other, iOwe: d.fromMemberId === me, cents: d.amountCents };
		})
		.sort(byText((d) => data.names.of(d.other)));

	if (!me || mine.length === 0) return null;

	return (
		<section aria-labelledby="between-you" className="flex flex-col gap-control">
			<h2 id="between-you" className="type-h4">
				Between you
			</h2>
			<ul className="flex flex-col">
				{mine.map(({ other, iOwe, cents }) => (
					<li key={other}>
						<Link
							to={`/groups/${data.group?.id}?tab=balances`}
							className="-mx-2 flex items-center gap-stack rounded-lg px-2 py-2 transition-colors duration-quick ease-out hover:bg-ink/5"
						>
							<Face seed={other} name={data.names.of(other)} size={32} />
							<span className="type-body-sm min-w-0 flex-1 truncate">
								{iOwe ? `You owe ${data.names.inSentence(other)}` : `${data.names.of(other)} owes you`}
							</span>
							<Amount cents={cents} tone={iOwe ? "owe" : "owed"} />
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
