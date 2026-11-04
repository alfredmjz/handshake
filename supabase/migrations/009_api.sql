-- Migration: 009_api
-- Description: The database half of API v1 for Pholio (docs/api-v1.md, ADR-003 and ADR-004 in
-- docs/architecture.md). People make read-only tokens with create_api_token(); the server keeps only
-- each token's SHA-256. The Vercel function logs in as handshake_api, which can run the api.v1_*
-- functions and nothing else. Each of them takes the token's hash, authenticates it and counts it
-- against a 60-a-minute window in the same call, then builds its answer in one statement.

-- =============================================================================
-- TABLE: api_tokens (not synced; no client access)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.api_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    -- Hex SHA-256 of the whole token, hsk_ prefix included.
    token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL DEFAULT 'read' CHECK (scope = 'read'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    rate_window_start TIMESTAMPTZ,
    rate_window_count INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON public.api_tokens (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_tokens FROM anon, authenticated;

-- =============================================================================
-- Managing tokens (online only, not for guests)
-- =============================================================================

CREATE OR REPLACE FUNCTION private.require_account()
RETURNS UUID
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;
    IF private.is_anonymous() THEN
        RAISE EXCEPTION 'Guests can''t connect apps' USING ERRCODE = 'HS403';
    END IF;
    RETURN v_user;
END;
$$;

-- The token is returned this once and never stored.
CREATE OR REPLACE FUNCTION public.create_api_token(p_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.require_account();
    v_token TEXT;
    v_row public.api_tokens;
BEGIN
    IF char_length(btrim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 60 THEN
        RAISE EXCEPTION 'Name the app with 1 to 60 characters' USING ERRCODE = 'HS422';
    END IF;

    -- One person's token creations go one at a time, so the limit holds.
    PERFORM pg_advisory_xact_lock(hashtextextended('api_tokens:' || v_user::TEXT, 0));
    IF (SELECT count(*) FROM public.api_tokens WHERE user_id = v_user AND revoked_at IS NULL) >= 10 THEN
        RAISE EXCEPTION 'You can connect at most 10 apps; revoke one first' USING ERRCODE = 'HS422';
    END IF;

    v_token := 'hsk_' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');

    INSERT INTO public.api_tokens (user_id, name, token_hash)
    VALUES (v_user, btrim(p_name), private.hash_token(v_token))
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('id', v_row.id, 'token', v_token, 'name', v_row.name, 'createdAt', v_row.created_at);
END;
$$;

-- Live tokens only, newest first.
CREATE OR REPLACE FUNCTION public.list_api_tokens()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.require_account();
BEGIN
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'id', t.id,
            'name', t.name,
            'scope', t.scope,
            'createdAt', t.created_at,
            'lastUsedAt', t.last_used_at
        ) ORDER BY t.created_at DESC, t.id)
        FROM public.api_tokens t
        WHERE t.user_id = v_user AND t.revoked_at IS NULL
    ), '[]'::JSONB);
END;
$$;

-- Revoking a token that isn't yours, or is revoked already, does nothing.
CREATE OR REPLACE FUNCTION public.revoke_api_token(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.require_account();
BEGIN
    UPDATE public.api_tokens SET revoked_at = NOW() WHERE id = p_id AND user_id = v_user AND revoked_at IS NULL;
END;
$$;

-- =============================================================================
-- The api schema and the handshake_api role
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Its password is never in a migration: supabase/seed.sql sets it locally, the owner in production.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'handshake_api') THEN
        CREATE ROLE handshake_api NOLOGIN;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA api TO handshake_api;

-- One UPDATE finds the live token, moves its one-minute window on if that minute is over, counts this
-- call and stamps last_used_at, returning the owner. HS401 for an unknown or revoked token; HS429 once
-- the window passes 60, with DETAIL = the whole seconds until it resets. Raising rolls the UPDATE back,
-- so refused calls don't count.
CREATE OR REPLACE FUNCTION private.api_authenticate(p_token_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_user UUID;
    v_count INT;
    v_window_start TIMESTAMPTZ;
BEGIN
    UPDATE public.api_tokens
    SET rate_window_start = CASE WHEN rate_window_start IS NULL OR rate_window_start <= NOW() - INTERVAL '1 minute'
            THEN NOW() ELSE rate_window_start END,
        rate_window_count = CASE WHEN rate_window_start IS NULL OR rate_window_start <= NOW() - INTERVAL '1 minute'
            THEN 1 ELSE rate_window_count + 1 END,
        last_used_at = NOW()
    WHERE token_hash = p_token_hash AND revoked_at IS NULL
    RETURNING user_id, rate_window_count, rate_window_start INTO v_user, v_count, v_window_start;

    IF v_user IS NULL THEN
        RAISE EXCEPTION 'The token is unknown or revoked' USING ERRCODE = 'HS401';
    END IF;
    IF v_count > 60 THEN
        RAISE EXCEPTION 'Too many requests with this token' USING ERRCODE = 'HS429',
            DETAIL = GREATEST(1, ceil(extract(EPOCH FROM v_window_start + INTERVAL '1 minute' - NOW())))::TEXT;
    END IF;

    RETURN v_user;
END;
$$;

-- One group as the token's owner sees it: their role, member id and totals over entries not deleted.
-- STABLE, so inside a caller's statement it reads that statement's snapshot.
CREATE OR REPLACE FUNCTION private.api_group(p_group public.groups, p_member public.group_members)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', p_group.id,
        'name', p_group.name,
        'role', p_member.role,
        'memberId', p_member.id,
        'paidCents', COALESCE(sum(s.paid_cents), 0),
        'owedCents', COALESCE(sum(s.owed_cents), 0),
        'completedAt', p_group.completed_at,
        'updatedAt', GREATEST(
            p_group.updated_at,
            (SELECT max(gm.updated_at) FROM public.group_members gm WHERE gm.group_id = p_group.id),
            (SELECT max(e.updated_at) FROM public.ledger_entries e WHERE e.group_id = p_group.id)
        )
    )
    FROM public.ledger_shares s
    JOIN public.ledger_entries e ON e.id = s.entry_id AND e.deleted_at IS NULL
    WHERE s.member_id = p_member.id;
$$;

-- =============================================================================
-- API v1 (the shapes src/server/api-v1/store.ts reads)
-- =============================================================================

CREATE OR REPLACE FUNCTION api.v1_me(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.api_authenticate(p_token_hash);
BEGIN
    RETURN (SELECT jsonb_build_object('userId', p.id, 'displayName', p.display_name) FROM public.profiles p WHERE p.id = v_user);
END;
$$;

-- Every group the owner is in now (completed ones too), by name.
CREATE OR REPLACE FUNCTION api.v1_groups(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.api_authenticate(p_token_hash);
BEGIN
    RETURN (
        SELECT COALESCE(jsonb_agg(private.api_group(g, gm) ORDER BY lower(g.name), g.id), '[]'::JSONB)
        FROM public.groups g
        JOIN public.group_members gm ON gm.group_id = g.id
        WHERE gm.user_id = v_user AND gm.deleted_at IS NULL AND g.deleted_at IS NULL
    );
END;
$$;

-- One group plus every member row (people who left and non-members too) with their totals. NULL when the
-- group is unknown, deleted or not the owner's; the call still counts, and the store reports HS404.
CREATE OR REPLACE FUNCTION api.v1_group(p_token_hash TEXT, p_group_id UUID)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.api_authenticate(p_token_hash);
BEGIN
    RETURN (
        SELECT private.api_group(g, gm) || jsonb_build_object('members', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'memberId', m.id,
                'displayName', m.display_name,
                'active', m.deleted_at IS NULL,
                'paidCents', COALESCE(t.paid, 0),
                'owedCents', COALESCE(t.owed, 0)
            ) ORDER BY lower(m.display_name), m.id), '[]'::JSONB)
            FROM public.group_members m
            LEFT JOIN LATERAL (
                SELECT sum(s.paid_cents) AS paid, sum(s.owed_cents) AS owed
                FROM public.ledger_shares s
                JOIN public.ledger_entries e ON e.id = s.entry_id AND e.deleted_at IS NULL
                WHERE s.member_id = m.id
            ) t ON TRUE
            WHERE m.group_id = g.id
        ))
        FROM public.groups g
        JOIN public.group_members gm ON gm.group_id = g.id AND gm.user_id = v_user AND gm.deleted_at IS NULL
        WHERE g.id = p_group_id AND g.deleted_at IS NULL
    );
END;
$$;

-- The entries feed (ADR-004). p_cursor maps group id -> the last version already read ({} = from the
-- start); p_group_id NULL means every group the owner is in. An entry's feed version is the newest of
-- its own and its conflicts' row_version, so opening or resolving a conflict sends it again. Groups go in
-- id order and entries by feed version, then id; the page stops after p_limit entries but always
-- finishes the version it is in. A fully read group's cursor value is its head_version. Cursor groups
-- the owner can no longer see come back in removedGroupIds and leave the cursor. NULL when p_group_id is
-- given and not the owner's; the call still counts, and the store reports HS404.
CREATE OR REPLACE FUNCTION api.v1_entries(p_token_hash TEXT, p_group_id UUID, p_cursor JSONB, p_limit INT)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_user UUID := private.api_authenticate(p_token_hash);
    v_cursor JSONB := COALESCE(p_cursor, '{}'::JSONB);
    v_limit INT := GREATEST(COALESCE(p_limit, 100), 1);
    v_result JSONB;
    v_found BOOLEAN;
BEGIN
    WITH visible AS (
        SELECT g.id AS group_id, g.head_version, gm.id AS member_id
        FROM public.groups g
        JOIN public.group_members gm ON gm.group_id = g.id AND gm.user_id = v_user AND gm.deleted_at IS NULL
        WHERE g.deleted_at IS NULL
    ),
    scope AS (
        SELECT v.*, COALESCE((v_cursor->>(v.group_id::TEXT))::BIGINT, 0) AS since
        FROM visible v
        WHERE p_group_id IS NULL OR v.group_id = p_group_id
    ),
    changed AS (
        SELECT e.id, e.group_id, s.member_id, GREATEST(e.row_version, COALESCE(c.version, 0)) AS feed_version
        FROM scope s
        JOIN public.ledger_entries e ON e.group_id = s.group_id
        LEFT JOIN LATERAL (
            SELECT max(ec.row_version) AS version FROM public.entry_conflicts ec WHERE ec.entry_id = e.id
        ) c ON TRUE
        WHERE GREATEST(e.row_version, COALESCE(c.version, 0)) > s.since
    ),
    numbered AS (
        SELECT ch.*, row_number() OVER (ORDER BY ch.group_id, ch.feed_version, ch.id) AS n FROM changed ch
    ),
    page_end AS (
        SELECT COALESCE(
            (SELECT max(b.n) FROM numbered a JOIN numbered b ON b.group_id = a.group_id AND b.feed_version = a.feed_version
                WHERE a.n = v_limit),
            (SELECT count(*) FROM numbered)
        ) AS n
    )
    SELECT
        jsonb_build_object(
            'entries', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', e.id,
                    'groupId', e.group_id,
                    'kind', e.kind,
                    'description', e.description,
                    'entryDate', e.entry_date,
                    'totalCents', e.amount_cents,
                    'involved', sh.member_id IS NOT NULL,
                    'paidCents', COALESCE(sh.paid_cents, 0),
                    'owedCents', COALESCE(sh.owed_cents, 0),
                    'hasConflict', EXISTS (
                        SELECT 1 FROM public.entry_conflicts ec WHERE ec.entry_id = e.id AND ec.resolved_at IS NULL
                    ),
                    'createdAt', e.created_at,
                    'updatedAt', e.updated_at,
                    'deletedAt', e.deleted_at
                ) ORDER BY p.n)
                FROM numbered p
                JOIN public.ledger_entries e ON e.id = p.id
                LEFT JOIN public.ledger_shares sh ON sh.entry_id = e.id AND sh.member_id = p.member_id
                WHERE p.n <= (SELECT n FROM page_end)
            ), '[]'::JSONB),
            'cursor', COALESCE((
                SELECT jsonb_object_agg(s.group_id::TEXT, CASE
                    WHEN NOT EXISTS (SELECT 1 FROM numbered x WHERE x.group_id = s.group_id AND x.n > (SELECT n FROM page_end))
                        THEN s.head_version
                    ELSE COALESCE(
                        (SELECT max(x.feed_version) FROM numbered x WHERE x.group_id = s.group_id AND x.n <= (SELECT n FROM page_end)),
                        s.since
                    )
                END)
                FROM scope s
            ), '{}'::JSONB),
            'hasMore', EXISTS (SELECT 1 FROM numbered x WHERE x.n > (SELECT n FROM page_end)),
            'removedGroupIds', COALESCE((
                SELECT jsonb_agg(k ORDER BY k)
                FROM jsonb_object_keys(v_cursor) k
                WHERE NOT EXISTS (SELECT 1 FROM visible v WHERE v.group_id::TEXT = k)
            ), '[]'::JSONB)
        ),
        EXISTS (SELECT 1 FROM scope)
    INTO v_result, v_found;

    IF p_group_id IS NOT NULL AND NOT v_found THEN
        RETURN NULL;
    END IF;
    RETURN v_result;
END;
$$;

-- =============================================================================
-- Who can run what
-- =============================================================================

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.v1_me(TEXT) TO handshake_api;
GRANT EXECUTE ON FUNCTION api.v1_groups(TEXT) TO handshake_api;
GRANT EXECUTE ON FUNCTION api.v1_group(TEXT, UUID) TO handshake_api;
GRANT EXECUTE ON FUNCTION api.v1_entries(TEXT, UUID, JSONB, INT) TO handshake_api;

REVOKE EXECUTE ON FUNCTION public.create_api_token(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_api_tokens() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_api_token(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_api_token(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_api_tokens() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_api_token(UUID) TO authenticated;

-- A trigger runs its function whoever has EXECUTE, so nobody needs it; this keeps handshake_api's reach
-- to the api schema.
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
