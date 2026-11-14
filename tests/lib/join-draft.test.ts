import { describe, expect, test } from "bun:test";

import {
	draftReady,
	nameClash,
	nameTaken,
	personalCode,
	stashDraft,
	stashReturn,
	takeDraft,
	takeReturn,
	type Draft,
	type Store,
} from "@/lib/join-draft";

function fakeStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

const throwing: Store = {
	getItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
	removeItem: () => {
		throw new Error("blocked");
	},
};

const throwingGetter: Store = () => {
	throw new Error("SecurityError");
};

const draft = (over: Partial<Draft>): Draft => ({ choice: null, name: "", personalCode: "", ...over });
const preview = { unclaimed: [{ displayName: "Gus" }], returning: [{ displayName: " Mo " }] };

describe("personalCode", () => {
	test("accepts a personal code in any display form, rejects group codes and junk", () => {
		expect(personalCode("7kqm-2dxh")).toBe("7KQM2DXH");
		expect(personalCode("HX7-K2P")).toBeNull();
		expect(personalCode("")).toBeNull();
	});
});

describe("draftReady", () => {
	test("needs a choice", () => expect(draftReady(draft({}))).toBe(false));
	test("claim is ready", () => expect(draftReady(draft({ choice: { kind: "claim", memberId: "m" } }))).toBe(true));
	test("new needs a name", () => {
		expect(draftReady(draft({ choice: { kind: "new" }, name: "  " }))).toBe(false);
		expect(draftReady(draft({ choice: { kind: "new" }, name: "Ann" }))).toBe(true);
	});
	test("back needs a member and a personal code", () => {
		expect(draftReady(draft({ choice: { kind: "back", memberId: null }, personalCode: "7KQM2DXH" }))).toBe(false);
		expect(draftReady(draft({ choice: { kind: "back", memberId: "m" }, personalCode: "HX7K2P" }))).toBe(false);
		expect(draftReady(draft({ choice: { kind: "back", memberId: "m" }, personalCode: "7KQM-2DXH" }))).toBe(true);
	});
});

describe("name clash", () => {
	test("nameTaken ignores case and spacing, across unclaimed and returning", () => {
		expect(nameTaken(preview, " gus")).toBe(true);
		expect(nameTaken(preview, "MO")).toBe(true);
		expect(nameTaken(preview, "Ann")).toBe(false);
	});
	test("only a new person with a name can clash", () => {
		expect(nameClash(draft({ choice: { kind: "new" }, name: "gus" }), preview)).toBe(true);
		expect(nameClash(draft({ choice: { kind: "new" }, name: "" }), preview)).toBe(false);
		expect(nameClash(draft({ choice: { kind: "claim", memberId: "m" }, name: "gus" }), preview)).toBe(false);
		expect(nameClash(draft({ name: "gus" }), preview)).toBe(false);
	});
});

describe("draft stash", () => {
	const saved = draft({ choice: { kind: "back", memberId: "m" }, name: "Ann", personalCode: "7KQM2DXH" });
	test("write, read once, then cleared", () => {
		const store = fakeStore();
		stashDraft(store, "HX7K2P", saved);
		expect(takeDraft(store, "OTHER")).toBeNull();
		expect(takeDraft(store, "HX7K2P")).toEqual(saved);
		expect(store.data.size).toBe(0);
		expect(takeDraft(store, "HX7K2P")).toBeNull();
	});
	test("a malformed stash is dropped and read as none", () => {
		const store = fakeStore();
		store.setItem("handshake.join.HX7K2P", "{nope");
		expect(takeDraft(store, "HX7K2P")).toBeNull();
		expect(store.data.size).toBe(0);
	});
	test("unavailable storage is tolerated", () => {
		expect(() => stashDraft(throwing, "C", saved)).not.toThrow();
		expect(takeDraft(throwing, "C")).toBeNull();
	});
});

describe("storage that cannot be reached", () => {
	test("a getter that throws is tolerated by every stash", () => {
		expect(() => stashDraft(throwingGetter, "C", draft({}))).not.toThrow();
		expect(takeDraft(throwingGetter, "C")).toBeNull();
		expect(() => stashReturn(throwingGetter, "C")).not.toThrow();
		expect(takeReturn(throwingGetter, "C")).toBe(false);
	});
	test("a getter is resolved on each call", () => {
		const store = fakeStore();
		stashDraft(() => store, "C", draft({ name: "Ann" }));
		expect(takeDraft(() => store, "C")?.name).toBe("Ann");
	});
});

describe("return stash", () => {
	test("write, read once, then cleared", () => {
		const store = fakeStore();
		expect(takeReturn(store, "7KQM2DXH")).toBe(false);
		stashReturn(store, "7KQM2DXH");
		expect(takeReturn(store, "7KQM2DXH")).toBe(true);
		expect(takeReturn(store, "7KQM2DXH")).toBe(false);
	});
	test("any other value is not a request", () => {
		const store = fakeStore();
		store.setItem("handshake.return.X", "0");
		expect(takeReturn(store, "X")).toBe(false);
		expect(store.data.size).toBe(0);
	});
	test("unavailable storage is tolerated", () => {
		expect(() => stashReturn(throwing, "C")).not.toThrow();
		expect(takeReturn(throwing, "C")).toBe(false);
	});
});
