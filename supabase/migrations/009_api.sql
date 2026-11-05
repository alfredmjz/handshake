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

-- Whether an entry counts in debts, balances and the API: a bill that isn't deleted, or a payment that
-- is confirmed (both sides agreed, or the other side has no login).
CREATE OR REPLACE FUNCTION private.entry_counts(p_entry public.ledger_entries)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT CASE WHEN p_entry.kind = 'expense' THEN p_entry.deleted_at IS NULL ELSE p_entry.payment_status = 'confirmed' END;
$$;

-- One group as the token's owner sees it: their role, member id and totals over the entries that count.
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
    JOIN public.ledger_entries e ON e.id = s.entry_id AND private.entry_counts(e)
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

-- Every group the owner is in now (completed ones too), by name, with their own paid and owed totals;
-- the handler's balance is paid − owed.
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

-- One group plus every member row (people who left and name-only people too) with their totals and
-- owedTo (payer member id -> cents) over the entries that count, from which the handler works out the
-- owner's debts with summarizeGroup. NULL when the group is unknown, deleted or not the owner's; the call
-- still counts, and the store reports HS404.
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
                'owedCents', COALESCE(t.owed, 0),
                'owedTo', COALESCE(o.owed_to, '{}'::JSONB)
            ) ORDER BY lower(m.display_name), m.id), '[]'::JSONB)
            FROM public.group_members m
            LEFT JOIN LATERAL (
                SELECT sum(s.paid_cents) AS paid, sum(s.owed_cents) AS owed
                FROM public.ledger_shares s
                JOIN public.ledger_entries e ON e.id = s.entry_id AND private.entry_counts(e)
                WHERE s.member_id = m.id
            ) t ON TRUE
            LEFT JOIN LATERAL (
                SELECT jsonb_object_agg(x.payer, x.cents) AS owed_to
                FROM (
                    SELECT p.payer_member_id AS payer, sum(p.owed_cents) AS cents
                    FROM public.ledger_share_parts p
                    JOIN public.ledger_entries e ON e.id = p.entry_id AND private.entry_counts(e)
                    WHERE p.member_id = m.id
                    GROUP BY p.payer_member_id
                ) x
            ) o ON TRUE
            WHERE m.group_id = g.id
        ))
        FROM public.groups g
        JOIN public.group_members gm ON gm.group_id = g.id AND gm.user_id = v_user AND gm.deleted_at IS NULL
        WHERE g.id = p_group_id AND g.deleted_at IS NULL
    );
END;
$$;

-- Replaced by api.v1_payments (ADR-004, 2026-11-04).
DROP FUNCTION IF EXISTS api.v1_entries(TEXT, UUID, JSONB, INT);

-- The payments feed (ADR-004): confirmed payments the owner is one side of. p_cursor maps group id -> the
-- last version already read ({} = from the start); p_group_id NULL means every group the owner is in. A
-- confirmed payment never changes, so its feed version is the version that confirmed it. Groups go in id
-- order and payments by version, then id; the page stops after p_limit payments but always finishes the
-- version it is in. A fully read group's cursor value is its head_version. Cursor groups the owner can no
-- longer see come back in removedGroupIds and leave the cursor. NULL when p_group_id is given and not the
-- owner's; the call still counts, and the store reports HS404.
CREATE OR REPLACE FUNCTION api.v1_payments(p_token_hash TEXT, p_group_id UUID, p_cursor JSONB, p_limit INT)
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
        SELECT g.id AS group_id, g.name AS group_name, g.head_version, gm.id AS member_id
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
        SELECT
            e.id, e.group_id, e.row_version AS feed_version, s.group_name, s.member_id,
            (SELECT x.member_id FROM public.ledger_shares x WHERE x.entry_id = e.id AND x.paid_cents > 0) AS from_member_id,
            (SELECT x.member_id FROM public.ledger_shares x WHERE x.entry_id = e.id AND x.owed_cents > 0) AS to_member_id
        FROM scope s
        JOIN public.ledger_entries e ON e.group_id = s.group_id
        WHERE e.kind = 'payment' AND e.payment_status = 'confirmed' AND e.row_version > s.since
            AND EXISTS (SELECT 1 FROM public.ledger_shares x WHERE x.entry_id = e.id AND x.member_id = s.member_id)
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
            'payments', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', e.id,
                    'groupId', e.group_id,
                    'groupName', p.group_name,
                    'direction', CASE WHEN p.from_member_id = p.member_id THEN 'sent' ELSE 'received' END,
                    'counterpartyMemberId', c.id,
                    'counterpartyName', c.display_name,
                    'amountCents', e.amount_cents,
                    'entryDate', e.entry_date,
                    'notes', e.notes,
                    'confirmedAt', e.confirmed_at
                ) ORDER BY p.n)
                FROM numbered p
                JOIN public.ledger_entries e ON e.id = p.id
                JOIN public.group_members c
                    ON c.id = CASE WHEN p.from_member_id = p.member_id THEN p.to_member_id ELSE p.from_member_id END
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
GRANT EXECUTE ON FUNCTION api.v1_payments(TEXT, UUID, JSONB, INT) TO handshake_api;

REVOKE EXECUTE ON FUNCTION public.create_api_token(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_api_tokens() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_api_token(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_api_token(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_api_tokens() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_api_token(UUID) TO authenticated;

-- A trigger runs its function whoever has EXECUTE, so nobody needs it; this keeps handshake_api's reach
-- to the api schema.
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
