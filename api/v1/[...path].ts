// The Vercel function for /api/v1/* (Bun runtime): the composition root. No logic lives here.
import { SQL } from "bun";

import { createApiV1 } from "../../src/server/api-v1/index";
import { createPostgresApiStore } from "../../src/server/api-v1/postgres-store";

const sql = new SQL({
	url: process.env.HANDSHAKE_API_DATABASE_URL,
	prepare: false,
	max: 5,
	idleTimeout: 20,
	connectionTimeout: 10,
});

const handle = createApiV1({ store: createPostgresApiStore(sql) });

export const GET = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
