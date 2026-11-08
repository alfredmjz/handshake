// Amounts are whole cents, never floats. Handshake is dollars only.

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// Parses what someone typed ("12", "12.5", "1,234.50") into cents; null when it isn't a valid amount.
export function parseAmount(input: string): number | null {
	const match = /^(\d*)(?:\.(\d*))?$/.exec(input.trim().replace(/,/g, ""));
	if (!match) return null;

	const [, whole = "", fraction = ""] = match;
	if (whole === "" && fraction === "") return null;
	if (fraction.length > 2) return null;

	const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
	return Number.isSafeInteger(cents) ? cents : null;
}

// "$1,234.50", and "−$3.33" with a real minus sign (U+2212).
export function formatAmount(cents: number): string {
	const abs = Math.abs(cents);
	const dollars = WHOLE_DOLLARS.format(Math.floor(abs / 100));
	const rest = String(abs % 100).padStart(2, "0");
	return `${cents < 0 ? "−" : ""}$${dollars}.${rest}`;
}
