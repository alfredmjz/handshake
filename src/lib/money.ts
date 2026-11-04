// Amounts are whole numbers of the currency's smallest unit (cents for CAD, yen for JPY), never floats.

export function minorUnitDigits(currency: string): number {
	return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

// Parses what someone typed ("12", "12.5", "1,234.50") into minor units; null when it isn't a valid amount.
export function parseAmount(input: string, currency: string): number | null {
	const digits = minorUnitDigits(currency);
	const match = /^(\d*)(?:\.(\d*))?$/.exec(input.trim().replace(/,/g, ""));
	if (!match) return null;

	const [, whole = "", fraction = ""] = match;
	if (whole === "" && fraction === "") return null;
	if (fraction.length > digits) return null;

	const minor = Number(whole || "0") * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
	return Number.isSafeInteger(minor) ? minor : null;
}

export function formatAmount(minor: number, currency: string, locale?: string): string {
	return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** minorUnitDigits(currency));
}

// Shares always add up to the total exactly. Leftover units go to the first shares, so 1000 split
// three ways is 334, 333, 333 (and -1000 is -334, -333, -333).
export function splitEvenly(totalMinor: number, count: number): number[] {
	if (!Number.isSafeInteger(totalMinor) || !Number.isInteger(count) || count <= 0) {
		throw new RangeError("splitEvenly needs a whole-unit total and a positive share count");
	}
	const sign = totalMinor < 0 ? -1 : 1;
	const total = Math.abs(totalMinor);
	const base = Math.floor(total / count);
	const leftover = total - base * count;
	return Array.from({ length: count }, (_, i) => sign * (base + (i < leftover ? 1 : 0)));
}
