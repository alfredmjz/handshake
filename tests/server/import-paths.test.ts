import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The Vercel function must bundle without the @/ alias (ADR-001): every runtime import in its import
// graph is relative. `import type` may use @/, since types are erased.

const ROOT = resolve(import.meta.dir, "../..");
const ENTRY = join(ROOT, "api/v1/[...path].ts");

function runtimeImports(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
		if (!match[2]) specifiers.push(match[3]);
	}
	for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) specifiers.push(match[1]);
	return specifiers;
}

function resolveFile(from: string, specifier: string): string | null {
	const base = resolve(dirname(from), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
		if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
	}
	return null;
}

test("the API function's import graph has no runtime @/ imports", () => {
	const seen = new Set<string>();
	const offenders: string[] = [];
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const specifier of runtimeImports(readFileSync(file, "utf8"))) {
			if (specifier.startsWith("@/")) offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
			if (!specifier.startsWith(".")) continue;
			const target = resolveFile(file, specifier);
			if (target) visit(target);
		}
	};
	visit(ENTRY);

	expect(offenders).toEqual([]);
	// The walk really reached the handler, the store and the ledger.
	expect([...seen].map((file) => relative(ROOT, file).replaceAll("\\", "/"))).toEqual(
		expect.arrayContaining(["src/server/api-v1/index.ts", "src/server/api-v1/postgres-store.ts", "src/lib/ledger.ts"])
	);
});
