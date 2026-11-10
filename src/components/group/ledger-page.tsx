import { CheckDoodle } from "@/components/art/doodles";
import { FacePile } from "@/components/art/face";
import { Hand, type HandKind } from "@/components/art/hand";
import { Amount, standingOf } from "@/components/money";
import { Inline, Stack } from "@/components/ui/stack";

type LedgerPageProps = {
	name: string;
	kind: HandKind;
	// Everyone in the group, you included.
	people: { id: string; name: string }[];
	balanceCents: number;
};

// Everyone but you.
function friendsLabel(others: number) {
	return others === 0 ? "Just you" : others === 1 ? "1 friend" : `${others} friends`;
}

const STANDING_LABEL = { owed: "You're owed", owe: "You owe", settled: "Your balance" } as const;

// The first page under a group's cover: its name, its people, and where you stand.
export function LedgerPage({ name, kind, people, balanceCents }: LedgerPageProps) {
	const standing = standingOf(balanceCents);
	return (
		<Stack gap="control" className="h-full">
			<div className="flex items-start justify-between gap-control">
				<h1 className="type-h2 line-clamp-2 break-words">{name}</h1>
				<Hand kind={kind} size={52} blob />
			</div>
			<Inline gap="control" wrap={false}>
				<FacePile people={people} size={30} />
				<span className="type-label text-muted-foreground">{friendsLabel(people.length - 1)}</span>
			</Inline>
			<Stack gap="none" className="mt-auto">
				<span className="type-label text-muted-foreground">{STANDING_LABEL[standing]}</span>
				{standing === "settled" ? (
					<Inline gap="control" wrap={false} className="type-h2">
						<CheckDoodle className="size-7" />
						Settled up
					</Inline>
				) : (
					<Amount cents={balanceCents} size="lg" tone={standing} />
				)}
			</Stack>
		</Stack>
	);
}
