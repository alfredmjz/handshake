import { CheckDoodle } from "@/components/art/doodles";
import { FacePile } from "@/components/art/face";
import { Hand, type HandKind } from "@/components/art/hand";
import { RollingAmount, standingOf } from "@/components/money";

type LedgerPageProps = {
	name: string;
	note: string | null;
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

// The page under a group's cover: its name, its people, and where you stand, in one glance.
export function LedgerPage({ name, note, kind, people, balanceCents }: LedgerPageProps) {
	const standing = standingOf(balanceCents);
	return (
		<div className="flex flex-col gap-stack">
			<div className="flex items-start justify-between gap-stack">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="type-h2 line-clamp-2 break-words">{name}</h1>
					{note && <p className="type-body-sm line-clamp-1 break-words text-muted-foreground">{note}</p>}
				</div>
				<Hand kind={kind} size={52} blob className="-mr-1 -mt-1" />
			</div>
			<div className="flex items-end justify-between gap-stack">
				<div className="flex min-w-0 flex-col">
					<span className="type-label text-muted-foreground">{STANDING_LABEL[standing]}</span>
					{standing === "settled" ? (
						<span className="type-money-lg flex items-center gap-1.5">
							<CheckDoodle className="size-6" />
							Settled
						</span>
					) : (
						<RollingAmount cents={balanceCents} size="lg" tone={standing} />
					)}
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1 pb-1">
					<FacePile people={people} size={28} max={4} />
					<span className="type-caption text-muted-foreground">{friendsLabel(people.length - 1)}</span>
				</div>
			</div>
		</div>
	);
}
