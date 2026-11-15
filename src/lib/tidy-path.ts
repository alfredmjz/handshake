// "//sign-in/link" as "/sign-in/link": a Site URL ending in "/" doubles the slash in the email's links, and the routes
// only match single ones. Null when the path is already tidy.
export function tidyPath(pathname: string): string | null {
	const tidy = pathname.replace(/\/{2,}/g, "/");
	return tidy === pathname ? null : tidy;
}
