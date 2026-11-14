import { describe, expect, test } from "bun:test";

import { draftReady, nameClash, nameTaken, personalCode, type Draft } from "@/lib/join-draft";

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
