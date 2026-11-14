import { describe, expect, test } from "bun:test";

import {
	DOESNT_WORK,
	failureNotice,
	isServerError,
	joinOutcome,
	NEEDS_CONNECTION,
	previewFailure,
} from "@/lib/online-outcome";

// Same name and shape as TransportError, which can't be imported here: its module needs the Supabase env keys.
function te(code: string, message = `msg ${code}`) {
	return Object.assign(new Error(message), { name: "TransportError", code });
}

describe("joinOutcome, joining with a group code", () => {
	test("HS404 means the code is gone", () => {
		expect(joinOutcome(te("HS404"), "join")).toEqual({ kind: "gone", title: DOESNT_WORK });
	});
	test.each(["HS409", "HS422"])("%s shows the server's message under the form", (code) => {
		expect(joinOutcome(te(code, "Taken"), "join")).toEqual({ kind: "inline", message: "Taken" });
	});
	test("a too-long name", () => {
		expect(joinOutcome(te("23514"), "join")).toEqual({ kind: "inline", message: "That name is too long" });
	});
	test("no connection", () => {
		expect(joinOutcome(te("network"), "join")).toEqual({ kind: "inline", message: "Joining needs a connection." });
	});
	test("anything else is a toast with the message", () => {
		expect(joinOutcome(te("XX000", "boom"), "join")).toEqual({
			kind: "toast",
			title: "Couldn't join",
			description: "boom",
		});
		expect(joinOutcome(new Error("plain"), "join")).toEqual({
			kind: "toast",
			title: "Couldn't join",
			description: "plain",
		});
		expect(joinOutcome("nope", "join")).toEqual({ kind: "toast", title: "Couldn't join", description: undefined });
		expect(joinOutcome(te("XX000", ""), "join")).toEqual({
			kind: "toast",
			title: "Couldn't join",
			description: undefined,
		});
	});
});

describe("joinOutcome, getting back in with a personal code", () => {
	test("HS404 means the code is gone", () => {
		expect(joinOutcome(te("HS404"), "return")).toEqual({ kind: "gone", title: DOESNT_WORK });
	});
	test("HS422 shows the server's message", () => {
		expect(joinOutcome(te("HS422", "Nope"), "return")).toEqual({ kind: "inline", message: "Nope" });
	});
	test("no connection", () => {
		expect(joinOutcome(te("network"), "return")).toEqual({ kind: "inline", message: "Joining needs a connection." });
	});
	test("HS409 and 23514 fall to the toast here", () => {
		for (const code of ["HS409", "23514"])
			expect(joinOutcome(te(code, "m"), "return")).toEqual({
				kind: "toast",
				title: "Couldn't get back in",
				description: "m",
			});
	});
	test("a non-error has no description", () => {
		expect(joinOutcome(undefined, "return")).toEqual({
			kind: "toast",
			title: "Couldn't get back in",
			description: undefined,
		});
	});
});

describe("previewFailure", () => {
	test("only HS404 is gone", () => {
		expect(previewFailure(te("HS404"))).toBe("gone");
		expect(previewFailure(te("network"))).toBe("failed");
		expect(previewFailure(new Error("x"))).toBe("failed");
	});
});

describe("failureNotice", () => {
	const authFetchError = Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError", status: 0 });
	test("a lost connection reads as needing one, from the transport or from auth", () => {
		expect(failureNotice(te("network", "Failed to fetch"), "Couldn't change your name")).toEqual([
			"Couldn't change your name",
			{ description: NEEDS_CONNECTION },
		]);
		expect(failureNotice(authFetchError, "Couldn't send the code")).toEqual([
			"Couldn't send the code",
			{ description: NEEDS_CONNECTION },
		]);
	});
	test("other errors keep their message; non-errors have none", () => {
		expect(failureNotice(te("HS422", "Bad"), "T")).toEqual(["T", { description: "Bad" }]);
		const authApi = Object.assign(new Error("Token has expired or is invalid"), { name: "AuthApiError" });
		expect(failureNotice(authApi, "That code didn't work")).toEqual([
			"That code didn't work",
			{ description: "Token has expired or is invalid" },
		]);
		for (const status of [500, 503]) {
			const serverError = Object.assign(new Error(`HTTP ${status}`), { name: "AuthRetryableFetchError", status });
			expect(failureNotice(serverError, "T")).toEqual(["T", { description: `HTTP ${status}` }]);
		}
		expect(failureNotice(new Error("Oops"), "T")).toEqual(["T", { description: "Oops" }]);
		expect(failureNotice("x", "T")).toEqual(["T", { description: undefined }]);
	});
	test("isServerError", () => {
		expect(isServerError(te("HS404"))).toBe(true);
		expect(isServerError(authFetchError)).toBe(false);
		expect(isServerError(new Error("x"))).toBe(false);
	});
});
