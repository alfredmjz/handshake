export const LOOKS = 5;
export const TINTS = 6;
export const SLOTS = LOOKS * TINTS;

// FNV-1a, so the same seed always lands on the same slot.
export function slotOf(seed: string): number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	return (h >>> 0) % SLOTS;
}

const tintOf = (slot: number) => Math.floor(slot / LOOKS);

// A face is one of 30 slots (drawing x colour). Each member takes the slot their key hashes to, unless
// that slot or its colour is already used: then the next slot with a colour nobody has yet, and once
// every colour is used, the next free slot. Keys go in sorted order so every device gives the same answer.
// The key is the login's user id when there is one, so a person keeps their face across groups.
export function assignSlots(members: { id: string; userId: string | null }[]): Map<string, number> {
	const keyed = members
		.map((m) => ({ id: m.id, key: m.userId ?? m.id }))
		.sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
	const taken = new Set<number>();
	const tints = new Set<number>();
	const slots = new Map<string, number>();
	for (const { id, key } of keyed) {
		const home = slotOf(key);
		const free = (s: number) => !taken.has(s) && (tints.size >= TINTS || !tints.has(tintOf(s)));
		let slot = home;
		if (taken.size < SLOTS) {
			for (let step = 0; step < SLOTS; step++) {
				const candidate = (home + step) % SLOTS;
				if (free(candidate)) {
					slot = candidate;
					break;
				}
			}
		}
		taken.add(slot);
		tints.add(tintOf(slot));
		slots.set(id, slot);
	}
	return slots;
}
