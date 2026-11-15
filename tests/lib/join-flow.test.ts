import { describe, expect, test } from "bun:test";

import type { ReadyDraft } from "@/lib/join-draft";
import { createJoinFlow } from "@/lib/join-flow";
import { DOESNT_WORK } from "@/lib/online-outcome";

import { fakeJoinPorts } from "../support/fake-join-ports";

const GROUP = "HX7K2P";
const PERSONAL = "7KQM2DXH";

// Same name and shape as TransportError, which can't be imported here: its module needs the Supabase env keys.
const te = (code: string, message = `msg ${code}`) =>
	Object.assign(new Error(message), { name: "TransportError", code });

const claim: ReadyDraft = { choice: { kind: "claim", memberId: "m1" }, name: "", personalCode: "" };
const newcomer: ReadyDraft = { choice: { kind: "new" }, name: "  Ann ", personalCode: "" };
const back: ReadyDraft = { choice: { kind: "back", memberId: "m2" }, name: "", personalCode: "7kqm-2dxh" };

describe("restore", () => {
	test("hands over the stashed draft once; later calls give the same answer", () => {
		const fake = fakeJoinPorts();
		createJoinFlow(fake.ports, GROUP).stash({ kind: "join", draft: newcomer });
		const flow = createJoinFlow(fake.ports, GROUP);
		expect(flow.restore()).toEqual({ draft: newcomer, returning: false });
		expect(fake.data.size).toBe(0);
		expect(flow.restore()).toEqual({ draft: newcomer, returning: false });
		expect(createJoinFlow(fake.ports, GROUP).restore()).toEqual({ draft: null, returning: false });
	});
	test("hands over a return once", () => {
		const fake = fakeJoinPorts();
		createJoinFlow(fake.ports, PERSONAL).stash({ kind: "return" });
		expect(createJoinFlow(fake.ports, PERSONAL).restore()).toEqual({ draft: null, returning: true });
		expect(createJoinFlow(fake.ports, PERSONAL).restore().returning).toBe(false);
	});
	test("a stash is kept per code", () => {
		const fake = fakeJoinPorts();
		createJoinFlow(fake.ports, GROUP).stash({ kind: "join", draft: claim });
		expect(createJoinFlow(fake.ports, "OTHER1").restore().draft).toBeNull();
		expect(createJoinFlow(fake.ports, GROUP).restore().draft).toEqual(claim);
	});
	test("a malformed stash is dropped and read as none", () => {
		const fake = fakeJoinPorts();
		fake.data.set(`handshake.join.${GROUP}`, "{nope");
		expect(createJoinFlow(fake.ports, GROUP).restore().draft).toBeNull();
		expect(fake.data.size).toBe(0);
	});
	test("storage that cannot be reached is read as nothing stashed", () => {
		const fake = fakeJoinPorts();
		fake.breakStorage();
		const flow = createJoinFlow(fake.ports, GROUP);
		expect(() => flow.stash({ kind: "join", draft: claim })).not.toThrow();
		expect(flow.restore()).toEqual({ draft: null, returning: false });
	});
});

describe("go", () => {
	test("sends the choice the way the server reads it", async () => {
		for (const [draft, args] of [
			[claim, { code: GROUP, claimMemberId: "m1", displayName: undefined, personalCode: undefined }],
			[newcomer, { code: GROUP, claimMemberId: undefined, displayName: "Ann", personalCode: undefined }],
			[back, { code: GROUP, claimMemberId: "m2", displayName: undefined, personalCode: PERSONAL }],
		] as const) {
			const fake = fakeJoinPorts();
			const result = createJoinFlow(fake.ports, GROUP).go({ kind: "join", draft });
			fake.succeed("g1");
			await result;
			expect(fake.calls[0]).toEqual({ name: "join", args });
		}
	});
	test("while one is in flight, asking again gives the same attempt", async () => {
		const fake = fakeJoinPorts();
		const flow = createJoinFlow(fake.ports, GROUP);
		const first = flow.go({ kind: "join", draft: claim });
		const second = flow.go({ kind: "join", draft: claim });
		expect(second).toBe(first);
		expect(fake.names()).toEqual(["join"]);
		fake.succeed("g1");
		expect(await second).toEqual({ kind: "in", groupId: "g1", showGuestCode: false });
	});
	test("syncs only after it succeeds", async () => {
		const fake = fakeJoinPorts();
		const flow = createJoinFlow(fake.ports, GROUP);
		const pending = flow.go({ kind: "join", draft: claim });
		expect(fake.names()).toEqual(["join"]);
		fake.succeed("g1");
		await pending;
		expect(fake.names()).toEqual(["join", "sync"]);
	});
	test("a failure is worded as today and does not sync; the next go tries again", async () => {
		const fake = fakeJoinPorts();
		const flow = createJoinFlow(fake.ports, GROUP);
		const first = flow.go({ kind: "join", draft: newcomer });
		fake.fail(te("HS409", "Ann is already in this group"));
		expect(await first).toEqual({ kind: "inline", message: "Ann is already in this group" });
		const second = flow.go({ kind: "join", draft: newcomer });
		expect(second).not.toBe(first);
		fake.fail(te("HS404"));
		expect(await second).toEqual({ kind: "gone", title: DOESNT_WORK });
		expect(fake.names()).toEqual(["join", "join"]);
	});
	test("a guest who joins as someone new or claimed is shown their code; coming back is not", async () => {
		for (const [draft, asGuest, showGuestCode] of [
			[newcomer, true, true],
			[claim, true, true],
			[back, true, false],
			[newcomer, false, false],
		] as const) {
			const fake = fakeJoinPorts();
			const result = createJoinFlow(fake.ports, GROUP).go({ kind: "join", draft }, asGuest);
			fake.succeed("g1");
			expect(await result).toEqual({ kind: "in", groupId: "g1", showGuestCode });
		}
	});
	test("getting back in with a personal code", async () => {
		const fake = fakeJoinPorts();
		const flow = createJoinFlow(fake.ports, PERSONAL);
		const ok = flow.go({ kind: "return" }, true);
		fake.succeed("g2");
		expect(await ok).toEqual({ kind: "in", groupId: "g2", showGuestCode: false });
		expect(fake.calls.slice(0, 2)).toEqual([{ name: "return", args: PERSONAL }, { name: "sync" }]);
		const failed = flow.go({ kind: "return" });
		fake.fail(te("HS409", "m"));
		expect(await failed).toEqual({ kind: "toast", title: "Couldn't get back in", description: "m" });
	});
});

describe("viaGuest", () => {
	test("stashes the way in, then signs in as a guest; the next mount finishes it", async () => {
		const fake = fakeJoinPorts();
		expect(await createJoinFlow(fake.ports, GROUP).viaGuest({ kind: "join", draft: back })).toBeNull();
		expect(fake.names()).toEqual(["guest"]);
		expect(createJoinFlow(fake.ports, GROUP).restore().draft).toEqual(back);
	});
	test("a failed guest sign-in comes back as a toast", async () => {
		const fake = fakeJoinPorts();
		fake.failGuest(new Error("Anonymous sign-ins are disabled"));
		expect(await createJoinFlow(fake.ports, PERSONAL).viaGuest({ kind: "return" })).toEqual({
			kind: "toast",
			title: "Couldn't continue as a guest",
			description: "Anonymous sign-ins are disabled",
		});
		const other = fakeJoinPorts();
		other.failGuest("nope");
		expect(await createJoinFlow(other.ports, PERSONAL).viaGuest({ kind: "return" })).toEqual({
			kind: "toast",
			title: "Couldn't continue as a guest",
			description: undefined,
		});
	});
});
