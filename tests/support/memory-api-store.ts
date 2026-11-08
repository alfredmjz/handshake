import { computeShares, type Share } from "../../src/lib/ledger";
import {
	ApiStoreError,
	type ApiStore,
	type GroupDetailRow,
	type GroupRowApi,
	type PaymentPageRow,
	type PaymentRowApi,
} from "../../src/server/api-v1/store";
import { hashToken } from "../../src/server/api-v1/token";
import type { ApiSeeder, BillItem } from "../api/store.contract";

// The in-memory ApiStore: the same answers as api.v1_* in 009_api.sql, over rows held in maps. It honours
// the seam's invariants, rate window included, and the store contract suite holds it to them.

type MemoryUser = { id: string; displayName: string };
type MemoryToken = { userId: string; revoked: boolean; windowStart: number | null; windowCount: number };
type MemoryGroup = {
	id: string;
	name: string;
	headVersion: number;
	deletedAt: string | null;
	completedAt: string | null;
	updatedAt: string;
};
type MemoryMember = {
	id: string;
	groupId: string;
	userId: string | null;
	displayName: string;
	role: "owner" | "member" | "guest";
	deletedAt: string | null;
	updatedAt: string;
};
type MemoryEntry = {
	id: string;
	groupId: string;
	kind: "expense" | "payment";
	amountCents: number;
	entryDate: string;
	notes: string | null;
	deletedAt: string | null;
	paymentStatus: "pending" | "confirmed" | "declined" | "undone" | null;
	confirmedAt: string | null;
	createdByMemberId: string;
	rowVersion: number;
	updatedAt: string;
	shares: Share[];
};

export type MemoryApiFixture = {
	now(): Date;
	users: Map<string, MemoryUser>;
	tokens: Map<string, MemoryToken>;
	groups: Map<string, MemoryGroup>;
	members: Map<string, MemoryMember>;
	entries: Map<string, MemoryEntry>;
};

export function emptyFixture(now: () => Date = () => new Date()): MemoryApiFixture {
	return { now, users: new Map(), tokens: new Map(), groups: new Map(), members: new Map(), entries: new Map() };
}

const WINDOW_MS = 60_000;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const counts = (entry: MemoryEntry) =>
	entry.kind === "expense" ? entry.deletedAt === null : entry.paymentStatus === "confirmed";

export function createMemoryApiStore(fixture: MemoryApiFixture): ApiStore {
	// private.api_authenticate: count the call in the token's one-minute window; refused calls don't count.
	function authenticate(tokenHash: string): string {
		const token = fixture.tokens.get(tokenHash);
		if (!token || token.revoked) throw new ApiStoreError("HS401", "The token is unknown or revoked");
		const now = fixture.now().getTime();
		const fresh = token.windowStart === null || token.windowStart <= now - WINDOW_MS;
		const start = fresh ? now : token.windowStart!;
		const count = fresh ? 1 : token.windowCount + 1;
		if (count > 60) {
			throw new ApiStoreError(
				"HS429",
				"Too many requests with this token",
				Math.max(1, Math.ceil((start + WINDOW_MS - now) / 1000))
			);
		}
		token.windowStart = start;
		token.windowCount = count;
		return token.userId;
	}

	// The owner's active rows in groups that aren't deleted.
	function visible(userId: string) {
		return [...fixture.members.values()]
			.filter((m) => m.userId === userId && m.deletedAt === null)
			.map((member) => ({ member, group: fixture.groups.get(member.groupId)! }))
			.filter(({ group }) => group.deletedAt === null);
	}

	const entriesOf = (groupId: string) => [...fixture.entries.values()].filter((e) => e.groupId === groupId);

	function totals(memberId: string, groupId: string) {
		let paidCents = 0;
		let owedCents = 0;
		const owedTo: Record<string, number> = {};
		for (const entry of entriesOf(groupId).filter(counts)) {
			const share = entry.shares.find((s) => s.memberId === memberId);
			if (!share) continue;
			paidCents += share.paidCents;
			owedCents += share.owedCents;
			for (const [payer, cents] of Object.entries(share.owedTo)) owedTo[payer] = (owedTo[payer] ?? 0) + cents;
		}
		return { paidCents, owedCents, owedTo };
	}

	function groupRow(group: MemoryGroup, member: MemoryMember): GroupRowApi {
		const { paidCents, owedCents } = totals(member.id, group.id);
		const stamps = [
			group.updatedAt,
			...[...fixture.members.values()].filter((m) => m.groupId === group.id).map((m) => m.updatedAt),
			...entriesOf(group.id).map((e) => e.updatedAt),
		];
		return {
			id: group.id,
			name: group.name,
			role: member.role,
			memberId: member.id,
			paidCents,
			owedCents,
			completedAt: group.completedAt,
			updatedAt: stamps.sort(byText).at(-1)!,
		};
	}

	const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
		byText(a.name.toLowerCase(), b.name.toLowerCase()) || byText(a.id, b.id);

	return {
		async me(tokenHash) {
			const user = fixture.users.get(authenticate(tokenHash))!;
			return { userId: user.id, displayName: user.displayName };
		},

		async groups(tokenHash) {
			return visible(authenticate(tokenHash))
				.map(({ group, member }) => groupRow(group, member))
				.sort(byName);
		},

		async group(tokenHash, groupId): Promise<GroupDetailRow> {
			const mine = visible(authenticate(tokenHash)).find(({ group }) => group.id === groupId);
			if (!mine) throw new ApiStoreError("HS404", "Not found");
			const members = [...fixture.members.values()]
				.filter((m) => m.groupId === groupId)
				.sort((a, b) => byText(a.displayName.toLowerCase(), b.displayName.toLowerCase()) || byText(a.id, b.id))
				.map((m) => ({
					memberId: m.id,
					displayName: m.displayName,
					active: m.deletedAt === null,
					...totals(m.id, groupId),
				}));
			return { ...groupRow(mine.group, mine.member), members };
		},

		async payments(tokenHash, query): Promise<PaymentPageRow> {
			const all = visible(authenticate(tokenHash));
			const scope = all.filter(({ group }) => query.groupId === null || group.id === query.groupId);
			if (query.groupId !== null && scope.length === 0) throw new ApiStoreError("HS404", "Not found");

			const since = (groupId: string) => query.cursor[groupId] ?? 0;
			const changed = scope
				.flatMap(({ group, member }) =>
					entriesOf(group.id)
						.filter(
							(e) =>
								e.kind === "payment" &&
								e.paymentStatus === "confirmed" &&
								e.rowVersion > since(group.id) &&
								e.shares.some((s) => s.memberId === member.id)
						)
						.map((entry) => ({ entry, group, member }))
				)
				.sort(
					(a, b) =>
						byText(a.group.id, b.group.id) || a.entry.rowVersion - b.entry.rowVersion || byText(a.entry.id, b.entry.id)
				);

			// Stop after `limit`, but finish the group version the limit falls in.
			let end = Math.min(query.limit, changed.length);
			if (end > 0 && end < changed.length) {
				const last = changed[end - 1];
				while (
					end < changed.length &&
					changed[end].group.id === last.group.id &&
					changed[end].entry.rowVersion === last.entry.rowVersion
				)
					end++;
			}
			const page = changed.slice(0, end);
			const rest = changed.slice(end);

			const payments: PaymentRowApi[] = page.map(({ entry, group, member }) => {
				const from = entry.shares.find((s) => s.paidCents > 0)!.memberId;
				const to = entry.shares.find((s) => s.owedCents > 0)!.memberId;
				const sent = from === member.id;
				const counterparty = fixture.members.get(sent ? to : from)!;
				return {
					id: entry.id,
					groupId: group.id,
					groupName: group.name,
					direction: sent ? "sent" : "received",
					counterpartyMemberId: counterparty.id,
					counterpartyName: counterparty.displayName,
					amountCents: entry.amountCents,
					entryDate: entry.entryDate,
					notes: entry.notes,
					confirmedAt: entry.confirmedAt!,
				};
			});

			const cursor: Record<string, number> = {};
			for (const { group } of scope) {
				const unread = rest.some((row) => row.group.id === group.id);
				const read = page.filter((row) => row.group.id === group.id).map((row) => row.entry.rowVersion);
				cursor[group.id] = !unread ? group.headVersion : read.length > 0 ? Math.max(...read) : since(group.id);
			}
			const visibleIds = new Set(all.map(({ group }) => group.id));
			return {
				payments,
				cursor,
				hasMore: rest.length > 0,
				removedGroupIds: Object.keys(query.cursor)
					.filter((id) => !visibleIds.has(id))
					.sort(byText),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// The memory seeder: what push_changes, join_group and create_api_token would leave behind, with each
// change taking the group's next version.
// ---------------------------------------------------------------------------

function sequentialIds() {
	let n = 0;
	return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

export function createMemorySeeder(fixture: MemoryApiFixture, newId: () => string = sequentialIds()): ApiSeeder {
	const usersByName = new Map<string, string>();
	const now = () => fixture.now().toISOString();
	const userId = (name: string) =>
		usersByName.get(name) ??
		(() => {
			throw new Error(`No user ${name}`);
		})();

	function stamp(groupId: string) {
		const group = fixture.groups.get(groupId)!;
		group.headVersion += 1;
		group.updatedAt = now();
		return group.headVersion;
	}
	function memberOf(name: string, groupId: string) {
		const id = userId(name);
		const member = [...fixture.members.values()].find(
			(m) => m.groupId === groupId && m.userId === id && m.deletedAt === null
		);
		if (!member) throw new Error(`${name} isn't in ${groupId}`);
		return member;
	}
	const canAnswer = (memberId: string) => {
		const member = fixture.members.get(memberId)!;
		return member.userId !== null && member.deletedAt === null;
	};
	function addMember(groupId: string, member: Omit<MemoryMember, "id" | "groupId" | "deletedAt" | "updatedAt">) {
		const id = newId();
		fixture.members.set(id, { id, groupId, deletedAt: null, updatedAt: now(), ...member });
		stamp(groupId);
		return id;
	}

	return {
		async user(name) {
			const id = newId();
			usersByName.set(name, id);
			fixture.users.set(id, { id, displayName: name });
			return id;
		},
		async group(owner, name) {
			const id = newId();
			fixture.groups.set(id, { id, name, headVersion: 0, deletedAt: null, completedAt: null, updatedAt: now() });
			addMember(id, { userId: userId(owner), displayName: owner, role: "owner" });
			return id;
		},
		async join(user, groupId) {
			return addMember(groupId, { userId: userId(user), displayName: user, role: "member" });
		},
		async addPerson(_by, groupId, name) {
			return addMember(groupId, { userId: null, displayName: name, role: "member" });
		},
		async memberId(user, groupId) {
			return memberOf(user, groupId).id;
		},
		async bill(by, groupId, item: BillItem) {
			const id = newId();
			const version = stamp(groupId);
			fixture.entries.set(id, {
				id,
				groupId,
				kind: "expense",
				amountCents: item.amountCents,
				entryDate: now().slice(0, 10),
				notes: null,
				deletedAt: null,
				paymentStatus: null,
				confirmedAt: null,
				createdByMemberId: memberOf(by, groupId).id,
				rowVersion: version,
				updatedAt: now(),
				shares: computeShares([{ id: "item", ...item }]),
			});
			return id;
		},
		async payment(by, groupId, from, to, amountCents, confirmBy) {
			const id = newId();
			const me = memberOf(by, groupId).id;
			const other = me === from ? to : me === to ? from : null;
			const pending = other !== null && canAnswer(other);
			fixture.entries.set(id, {
				id,
				groupId,
				kind: "payment",
				amountCents,
				entryDate: now().slice(0, 10),
				notes: null,
				deletedAt: null,
				paymentStatus: pending ? "pending" : "confirmed",
				confirmedAt: pending ? null : now(),
				createdByMemberId: me,
				rowVersion: stamp(groupId),
				updatedAt: now(),
				shares: computeShares([{ id, amountCents, paidBy: from, splitAmong: [to] }]),
			});
			if (pending && confirmBy) {
				const entry = fixture.entries.get(id)!;
				Object.assign(entry, {
					paymentStatus: "confirmed",
					confirmedAt: now(),
					rowVersion: stamp(groupId),
					updatedAt: now(),
				});
			}
			return id;
		},
		async leave(user, groupId) {
			const member = memberOf(user, groupId);
			const version = stamp(groupId);
			Object.assign(member, {
				deletedAt: now(),
				updatedAt: now(),
				role: member.role === "owner" ? "member" : member.role,
			});
			for (const entry of fixture.entries.values()) {
				if (entry.paymentStatus === "pending" && entry.shares.some((s) => s.memberId === member.id)) {
					Object.assign(entry, { paymentStatus: "undone", rowVersion: version, updatedAt: now() });
				}
			}
		},
		async deleteGroup(_owner, groupId) {
			stamp(groupId);
			fixture.groups.get(groupId)!.deletedAt = now();
		},
		async token(user) {
			const raw = `hsk_${crypto.randomUUID().replace(/-/g, "")}${"x".repeat(11)}`;
			const hash = await hashToken(raw);
			fixture.tokens.set(hash, { userId: userId(user), revoked: false, windowStart: null, windowCount: 0 });
			return {
				hash,
				revoke: async () => {
					fixture.tokens.get(hash)!.revoked = true;
				},
			};
		},
		async headVersion(groupId) {
			return fixture.groups.get(groupId)!.headVersion;
		},
	};
}

// A memory store and its seeder over one fixture.
export function createMemoryApiWorld(options: { now?: () => Date; newId?: () => string } = {}) {
	const fixture = emptyFixture(options.now);
	return { fixture, store: createMemoryApiStore(fixture), seed: createMemorySeeder(fixture, options.newId) };
}
