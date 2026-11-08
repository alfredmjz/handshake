import type { ErrorBody, ErrorCode } from "./types";

// Headers on every response (docs/api-v1.md "Headers on every response").
const COMMON = {
	"Cache-Control": "no-store",
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "Authorization",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...COMMON, "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

export function preflight(): Response {
	return new Response(null, { status: 204, headers: { ...COMMON, "Access-Control-Max-Age": "86400" } });
}

const STATUS: Record<ErrorCode, number> = {
	bad_request: 400,
	invalid_token: 401,
	not_found: 404,
	method_not_allowed: 405,
	rate_limited: 429,
	server_error: 500,
};

const MESSAGE: Record<ErrorCode, string> = {
	bad_request: "The request is invalid.",
	invalid_token: "The token is missing, unknown or revoked.",
	not_found: "Not found.",
	method_not_allowed: "Only GET and OPTIONS are allowed.",
	rate_limited: "Too many requests. Try again in a minute.",
	server_error: "Something went wrong. Try again later.",
};

export function error(code: ErrorCode, message = MESSAGE[code], headers: Record<string, string> = {}): Response {
	const body: ErrorBody = { error: { code, message } };
	return json(STATUS[code], body, headers);
}

// Postgres's JSON timestamps (2026-11-03T18:20:00.123456+00:00) as ISO 8601 UTC with milliseconds.
export function iso(timestamp: string): string {
	return new Date(timestamp).toISOString();
}
