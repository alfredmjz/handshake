// Text as Postgres stores and measures it, so the device agrees with the server.

// char_length counts code points, not UTF-16 units.
export function charLength(text: string): number {
	return [...text].length;
}

// btrim + NULLIF(…, ''), as private.group_note and payment.decline store a note: spaces only are trimmed,
// and blank is no note.
export function storedNote(note: string | null | undefined): string | null {
	return note?.replace(/^ +| +$/g, "") || null;
}
