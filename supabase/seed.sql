-- Local only (`bun run db:reset` runs it after the migrations). Lets the API function's local connection
-- (HANDSHAKE_API_DATABASE_URL in .env.local, see README.md) log in as handshake_api. Production sets its own password
-- once, by hand, in the SQL editor; it never goes in a migration.
ALTER ROLE handshake_api WITH LOGIN PASSWORD 'handshake_api_local';
