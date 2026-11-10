// Amounts are whole cents, never floats. The app shows dollars only.

// Parses what someone typed ("12", "12.5", "1,234.50") into cents; null when it isn't a valid amount.
export function parseAmount(input: string): number | null {
	const match = /^(\d+|\d{1,3}(?:,\d{3})+)?(?:\.(\d{0,2}))?$/.exec(input.trim());
	if (!match) return null;

	const [, whole = "", fraction = ""] = match;
	if (whole === "" && fraction === "") return null;

	const cents = Number(whole.replace(/,/g, "") || "0") * 100 + Number(fraction.padEnd(2, "0"));
	return Number.isSafeInteger(cents) ? cents : null;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatAmount(cents: number): string {
	const text = dollars.format(Math.abs(cents) / 100);
	return cents < 0 ? `−${text}` : text;
}
