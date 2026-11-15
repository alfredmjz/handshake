import { describe, expect, test } from "bun:test";

import { tidyPath } from "@/lib/tidy-path";

describe("tidyPath", () => {
	test("collapses doubled slashes", () => {
		expect(tidyPath("//sign-in/link")).toBe("/sign-in/link");
		expect(tidyPath("///sign-in//link")).toBe("/sign-in/link");
		expect(tidyPath("//")).toBe("/");
	});

	test("leaves a tidy path alone", () => {
		expect(tidyPath("/")).toBeNull();
		expect(tidyPath("/sign-in/link")).toBeNull();
		expect(tidyPath("/groups/abc/entries/def")).toBeNull();
	});
});
