import { describe, expect, test } from "bun:test";

import { planChange } from "@/lib/changes";
import type { Mutation } from "@/lib/sync/types";

import { expectedOutcome, NOW, REFUSAL_CASES, worldState } from "../fixtures/refusal-cases";
import type { RefusalCase } from "../fixtures/refusal-cases";

const MUTATION_TYPES = [
	"group.create",
	"group.rename",
	"group.describe",
	"group.recolor",
	"group.sticker",
	"group.delete",
	"group.complete",
	"group.reopen",
	"group.recode",
	"member.add",
	"member.rename",
	"member.remove",
	"entry.create",
	"entry.update",
	"entry.delete",
	"conflict.resolve",
	"invite.create",
	"invite.revoke",
	"payment.record",
	"payment.confirm",
	"payment.decline",
	"payment.undo",
	"nudge.send",
] as const satisfies readonly Mutation["type"][];
// A new kind of change fails typecheck here until it is listed (and given cases).
const everyKindListed: Exclude<Mutation["type"], (typeof MUTATION_TYPES)[number]> extends never ? true : false = true;

function plan(refusalCase: RefusalCase) {
	let ids = 0;
	return planChange(worldState(refusalCase.actor, refusalCase.group), refusalCase.intent!, {
		newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
		now: NOW,
		today: NOW.slice(0, 10),
		isAnonymous: refusalCase.actor === "kim",
	});
}

describe("planChange against the refusal case table", () => {
	for (const refusalCase of REFUSAL_CASES) {
		const label = `${refusalCase.mutation.type}: ${refusalCase.name}`;
		if (refusalCase.intent === null) {
			test.skip(`${label} (no intent: only push_changes runs it)`, () => {});
			continue;
		}
		test(label, () => {
			const result = plan(refusalCase);
			const outcome = result.ok ? "accepted" : result.code;
			expect(outcome).toBe(expectedOutcome(refusalCase, "planChange"));
			// The intent and the mutation column describe the same change.
			if (result.ok && result.mutations.length > 0) expect(result.mutations[0].type).toBe(refusalCase.mutation.type);
		});
	}
});

describe("the refusal case table", () => {
	test("lists every kind of change", () => {
		expect(everyKindListed).toBe(true);
	});

	test.each([...MUTATION_TYPES])("%s has an accepted case and a refused one", (type) => {
		const cases = REFUSAL_CASES.filter((refusalCase) => refusalCase.mutation.type === type && !refusalCase.mismatch);
		expect(cases.some((refusalCase) => refusalCase.expect === "accepted")).toBe(true);
		expect(cases.some((refusalCase) => refusalCase.expect !== "accepted")).toBe(true);
	});
});
