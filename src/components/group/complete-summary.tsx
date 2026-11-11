import { Face } from "@/components/art/face";
import { Amount } from "@/components/money";
import { List, ListRow } from "@/components/ui/list";
import { listNames } from "@/lib/settle-view";

export type OwedRow = { key: string; fromId: string; text: string; cents: number };

// What completing a group leaves behind: who still owes whom (scrolls past about six), payments waiting, guests leaving.
export function CompleteSummary({ rows, waiting, guests }: { rows: OwedRow[]; waiting: number; guests: string[] }) {
	return (
		<>
			{rows.length > 0 && (
				<List aria-label="Still owed" className="max-h-72 overflow-y-auto rounded-lg bg-muted px-panel">
					{rows.map((r) => (
						<ListRow
							key={r.key}
							leading={<Face seed={r.fromId} name="" size={28} />}
							title={r.text}
							trailing={<Amount cents={r.cents} tone="owe" />}
						/>
					))}
				</List>
			)}
			{waiting > 0 && (
				<p className="type-label text-muted-foreground">
					+{waiting} {waiting === 1 ? "payment" : "payments"} waiting
				</p>
			)}
			{guests.length > 0 && (
				<p className="type-label text-muted-foreground">
					{listNames(guests)} {guests.length === 1 ? "is a guest" : "are guests"} and will lose access.{" "}
					{guests.length === 1 ? "Their name" : "Their names"} and history stay.
				</p>
			)}
		</>
	);
}
