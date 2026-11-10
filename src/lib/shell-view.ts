// The invite token from a pasted link ("https://…/join/abc") or a bare token; null when it isn't one.
export function inviteTokenFrom(input: string): string | null {
	const text = input.trim();
	const inLink = /\/join\/([A-Za-z0-9_-]+)/.exec(text);
	if (inLink) return inLink[1];
	return /^[A-Za-z0-9_-]{20,}$/.test(text) ? text : null;
}

export type Overall = { standing: "owed" | "owe" | "settled"; cents: number };

// Net of your balance in every open group: positive means friends owe you.
export function overallOf(balances: number[]): Overall {
	const cents = balances.reduce((sum, b) => sum + b, 0);
	return { standing: cents > 0 ? "owed" : cents < 0 ? "owe" : "settled", cents: Math.abs(cents) };
}

// One person's balance in a group summary; 0 when they aren't in it.
export function balanceFor(people: { memberId: string; balanceCents: number }[], memberId: string | null | undefined) {
	return people.find((p) => p.memberId === memberId)?.balanceCents ?? 0;
}

export type OpenDebt = { groupName: string; otherName: string; cents: number; direction: "owe" | "owed" };

// "You still owe Sam $10.00 in Banff trip" / "Sam still owes you $10.00 in Banff trip".
export function describeDebt(d: OpenDebt, format: (cents: number) => string): string {
	return d.direction === "owe"
		? `You still owe ${d.otherName} ${format(d.cents)} in ${d.groupName}`
		: `${d.otherName} still owes you ${format(d.cents)} in ${d.groupName}`;
}
