-- ============================================================================
-- Handshake schema baseline: migrations 001-020 squashed into one file (2026-11-14).
-- It rebuilds the whole schema on a clean Supabase project. The original migrations and their
-- reasoning are in git history (before this file) and docs/architecture.md §7 and §11.
-- New changes go in new migrations from 021, as before.
-- ============================================================================
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- The API v1 role (Vercel function). Roles live outside any one database, so a dump leaves this out.
-- Its password is never in a migration: supabase/seed.sql sets it locally, the owner in production.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'handshake_api') THEN
        CREATE ROLE handshake_api NOLOGIN;
    END IF;
END;
$$;

-- A new Supabase project grants anon, authenticated and service_role everything on new objects in public.
-- Turn that off while the schema is built, so the exact grants below are the only ones; the
-- ALTER DEFAULT PRIVILEGES lines at the end put Supabase's defaults back.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS "api";

ALTER SCHEMA "api" OWNER TO "postgres";

CREATE SCHEMA IF NOT EXISTS "private";

ALTER SCHEMA "private" OWNER TO "postgres";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "api"."v1_group"("p_token_hash" "text", "p_group_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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

ALTER FUNCTION "api"."v1_group"("p_token_hash" "text", "p_group_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "api"."v1_groups"("p_token_hash" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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

ALTER FUNCTION "api"."v1_groups"("p_token_hash" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "api"."v1_me"("p_token_hash" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := private.api_authenticate(p_token_hash);
BEGIN
    RETURN (SELECT jsonb_build_object('userId', p.id, 'displayName', p.display_name) FROM public.profiles p WHERE p.id = v_user);
END;
$$;

ALTER FUNCTION "api"."v1_me"("p_token_hash" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "api"."v1_payments"("p_token_hash" "text", "p_group_id" "uuid", "p_cursor" "jsonb", "p_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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

ALTER FUNCTION "api"."v1_payments"("p_token_hash" "text", "p_group_id" "uuid", "p_cursor" "jsonb", "p_limit" integer) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."allowed_when_completed"("p_action" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT COALESCE(p_action IN ('group.delete', 'group.reopen', 'member.remove.self', 'payment.respond'), FALSE);
$$;

ALTER FUNCTION "private"."allowed_when_completed"("p_action" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."answer_payment"("p_user" "uuid", "p_mutation" "jsonb", "p_confirm" boolean) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
    v_sides RECORD;
    v_as_payer BOOLEAN;
    v_version BIGINT;
BEGIN
    v_me := private.require(p_user, v_group_id, 'payment.respond');
    v_entry := private.pending_payment(v_group_id, (p_mutation->>'entryId')::UUID);
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO v_sides FROM private.payment_sides(v_entry.id);
    IF v_me.id = v_sides.from_member_id AND v_entry.payer_confirmed_at IS NULL THEN
        v_as_payer := TRUE;
    ELSIF v_me.id = v_sides.to_member_id AND v_entry.receiver_confirmed_at IS NULL THEN
        v_as_payer := FALSE;
    ELSE
        RAISE EXCEPTION 'Only the other side of this payment can answer it' USING ERRCODE = 'HS403';
    END IF;
    IF NOT p_confirm AND p_mutation->>'note' IS NOT NULL
        AND (jsonb_typeof(p_mutation->'note') <> 'string' OR char_length(p_mutation->>'note') > 200) THEN
        RAISE EXCEPTION 'A note must be text of at most 200 characters' USING ERRCODE = 'HS422';
    END IF;

    v_version := private.next_group_version(v_group_id);
    IF p_confirm THEN
        UPDATE public.ledger_entries
        SET payment_status = 'confirmed',
            payer_confirmed_at = CASE WHEN v_as_payer THEN NOW() ELSE payer_confirmed_at END,
            receiver_confirmed_at = CASE WHEN v_as_payer THEN receiver_confirmed_at ELSE NOW() END,
            confirmed_at = NOW(),
            updated_by_member_id = v_me.id, updated_at = NOW(), row_version = v_version
        WHERE id = v_entry.id;
    ELSE
        UPDATE public.ledger_entries
        SET payment_status = 'declined', closed_at = NOW(), close_note = NULLIF(btrim(p_mutation->>'note'), ''),
            updated_by_member_id = v_me.id, updated_at = NOW(), row_version = v_version
        WHERE id = v_entry.id;
    END IF;
END;
$$;

ALTER FUNCTION "private"."answer_payment"("p_user" "uuid", "p_mutation" "jsonb", "p_confirm" boolean) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."api_authenticate"("p_token_hash" "text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
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

ALTER FUNCTION "private"."api_authenticate"("p_token_hash" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."new_join_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_code TEXT;
BEGIN
    LOOP
        v_code := private.random_code();
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.groups WHERE join_code = v_code);
    END LOOP;
    RETURN v_code;
END;
$$;

ALTER FUNCTION "private"."new_join_code"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."group_members" (
    "id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "display_name" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "row_version" bigint DEFAULT 0 NOT NULL,
    "joined_at" timestamp with time zone,
    CONSTRAINT "group_members_display_name_check" CHECK ((("char_length"("btrim"("display_name")) >= 1) AND ("char_length"("btrim"("display_name")) <= 60))),
    CONSTRAINT "group_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'member'::"text", 'guest'::"text"])))
);

ALTER TABLE "public"."group_members" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."groups" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "base_currency" character(3) DEFAULT 'CAD'::"bpchar" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "head_version" bigint DEFAULT 0 NOT NULL,
    "row_version" bigint DEFAULT 0 NOT NULL,
    "completed_at" timestamp with time zone,
    "completed_by_member_id" "uuid",
    "note" "text",
    "join_code" "text" DEFAULT "private"."new_join_code"() NOT NULL,
    "cover_color" "text",
    "cover_sticker" "text",
    CONSTRAINT "groups_base_currency_check" CHECK (("base_currency" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "groups_join_code_check" CHECK (("join_code" ~ '^[A-HJKMNP-Z2-9]{6}$'::"text")),
    CONSTRAINT "groups_name_check" CHECK ((("char_length"("btrim"("name")) >= 1) AND ("char_length"("btrim"("name")) <= 80))),
    CONSTRAINT "groups_note_check" CHECK ((("note" = "btrim"("note")) AND (("char_length"("note") >= 1) AND ("char_length"("note") <= 120))))
);

ALTER TABLE "public"."groups" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."api_group"("p_group" "public"."groups", "p_member" "public"."group_members") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
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

ALTER FUNCTION "private"."api_group"("p_group" "public"."groups", "p_member" "public"."group_members") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_conflict_resolve"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_conflict public.entry_conflicts;
    v_final JSONB := p_mutation->'entry';
    v_version BIGINT;
BEGIN
    v_me := private.require(p_user, v_group_id, 'conflict.resolve');

    SELECT * INTO v_conflict
    FROM public.entry_conflicts
    WHERE id = (p_mutation->>'conflictId')::UUID AND group_id = v_group_id;

    IF v_conflict.id IS NULL THEN
        RAISE EXCEPTION 'That conflict doesn''t exist in this group' USING ERRCODE = 'HS404';
    END IF;
    IF v_conflict.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION '% already resolved this',
            (SELECT display_name FROM public.group_members WHERE id = v_conflict.resolved_by_member_id)
            USING ERRCODE = 'HS409';
    END IF;
    IF (p_mutation->>'entryId')::UUID IS DISTINCT FROM v_conflict.entry_id THEN
        RAISE EXCEPTION 'That conflict is about another entry' USING ERRCODE = 'HS422';
    END IF;
    IF p_mutation->>'resolution' IS NULL OR p_mutation->>'resolution' NOT IN ('kept_current', 'took_proposed', 'merged') THEN
        RAISE EXCEPTION 'resolution must be kept_current, took_proposed or merged' USING ERRCODE = 'HS422';
    END IF;
    IF jsonb_typeof(v_final) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'A resolution needs the final entry, or deleted: true' USING ERRCODE = 'HS422';
    END IF;

    v_version := private.next_group_version(v_group_id);
    IF v_final->'deleted' = 'true'::JSONB THEN
        PERFORM private.delete_entry(v_conflict.entry_id, v_me.id, v_version);
    ELSE
        PERFORM private.validate_entry(v_group_id, v_final);
        PERFORM private.save_entry(v_conflict.entry_id, v_group_id, v_final, v_me.id, v_version, FALSE);
    END IF;

    UPDATE public.entry_conflicts
    SET resolved_at = NOW(),
        resolved_by_member_id = v_me.id,
        resolution = p_mutation->>'resolution',
        row_version = v_version
    WHERE id = v_conflict.id;
END;
$$;

ALTER FUNCTION "private"."apply_conflict_resolve"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_entry_create"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
BEGIN
    v_me := private.require(p_user, v_group_id, 'entry.create');
    PERFORM private.validate_entry(v_group_id, p_mutation);

    PERFORM private.save_entry(
        (p_mutation->>'entryId')::UUID, v_group_id, p_mutation, v_me.id, private.next_group_version(v_group_id), TRUE
    );
END;
$$;

ALTER FUNCTION "private"."apply_entry_create"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_entry_delete"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
    v_version BIGINT;
BEGIN
    -- Who added it decides the action; a bill never stored is checked as your own.
    v_me := private.caller_member(p_user, v_group_id);
    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = (p_mutation->>'entryId')::UUID;
    v_me := private.require(p_user, v_group_id,
        CASE WHEN v_entry.id IS NULL OR v_entry.created_by_member_id = v_me.id THEN 'entry.delete.own' ELSE 'entry.delete.others' END);

    v_entry := private.stored_bill(v_group_id, (p_mutation->>'entryId')::UUID);
    -- Never stored, or deleted already by anyone: nothing left to do, and nothing to disagree about.
    IF v_entry.id IS NULL OR v_entry.deleted_at IS NOT NULL THEN
        RETURN;
    END IF;

    v_version := private.next_group_version(v_group_id);
    IF private.is_stale(p_mutation, v_entry, v_me.id) THEN
        PERFORM private.open_conflict(p_mutation, v_entry, v_me.id, v_version, NULL);
    ELSE
        PERFORM private.delete_entry(v_entry.id, v_me.id, v_version);
    END IF;
END;
$$;

ALTER FUNCTION "private"."apply_entry_delete"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_entry_update"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
    v_version BIGINT;
BEGIN
    v_me := private.require(p_user, v_group_id, 'entry.update');

    v_entry := private.stored_bill(v_group_id, (p_mutation->>'entryId')::UUID);
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;
    PERFORM private.validate_entry(v_group_id, p_mutation);

    v_version := private.next_group_version(v_group_id);
    IF private.is_stale(p_mutation, v_entry, v_me.id) THEN
        PERFORM private.open_conflict(p_mutation, v_entry, v_me.id, v_version, private.entry_proposal(p_mutation));
    ELSE
        PERFORM private.save_entry(v_entry.id, v_group_id, p_mutation, v_me.id, v_version, FALSE);
    END IF;
END;
$$;

ALTER FUNCTION "private"."apply_entry_update"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_complete"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_version BIGINT;
    v_guest UUID;
BEGIN
    v_me := private.require(p_user, v_group_id, 'group.complete');

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET completed_at = NOW(), completed_by_member_id = v_me.id, updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;

    FOR v_guest IN
        UPDATE public.group_members gm
        SET user_id = NULL, role = 'member', joined_at = NULL, updated_at = NOW(), row_version = v_version
        FROM auth.users u
        WHERE gm.group_id = v_group_id AND gm.role = 'guest' AND u.id = gm.user_id AND u.is_anonymous
        RETURNING u.id
    LOOP
        -- Deleting the user also deletes their profile and sync_mutations rows.
        DELETE FROM auth.users u
        WHERE u.id = v_guest AND u.is_anonymous AND NOT EXISTS (
            SELECT 1 FROM public.group_members gm
            JOIN public.groups g ON g.id = gm.group_id
            WHERE gm.user_id = v_guest AND gm.deleted_at IS NULL AND g.deleted_at IS NULL
        );
    END LOOP;
END;
$$;

ALTER FUNCTION "private"."apply_group_complete"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_create"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_note TEXT;
    v_version BIGINT;
BEGIN
    -- An account rule outside the matrix.
    IF private.is_anonymous() THEN
        RAISE EXCEPTION 'Guests can''t create groups' USING ERRCODE = 'HS403';
    END IF;
    v_note := private.group_note(p_mutation);
    PERFORM private.require_name(p_mutation->>'name', 80, 'A group name');
    IF p_mutation->>'displayName' IS NOT NULL THEN
        PERFORM private.require_name(p_mutation->>'displayName', 60, 'A name');
    END IF;

    -- Devices stop sending baseCurrency; the column default applies then.
    IF p_mutation->>'baseCurrency' IS NULL THEN
        INSERT INTO public.groups (id, name, note, created_by)
        VALUES (v_group_id, btrim(p_mutation->>'name'), v_note, p_user);
    ELSE
        INSERT INTO public.groups (id, name, note, base_currency, created_by)
        VALUES (v_group_id, btrim(p_mutation->>'name'), v_note, upper(p_mutation->>'baseCurrency'), p_user);
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET row_version = v_version WHERE id = v_group_id;

    INSERT INTO public.group_members (id, group_id, user_id, display_name, role, joined_at, row_version)
    VALUES (
        (p_mutation->>'memberId')::UUID,
        v_group_id,
        p_user,
        COALESCE(btrim(p_mutation->>'displayName'), (SELECT display_name FROM public.profiles WHERE id = p_user)),
        'owner',
        NOW(),
        v_version
    );
END;
$$;

ALTER FUNCTION "private"."apply_group_create"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_delete"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.delete');

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET deleted_at = NOW(), updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_delete"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_describe"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_note TEXT;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.rename');
    v_note := private.group_note(p_mutation);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET note = v_note, updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_describe"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_recode"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.recode');

    -- Taken first: next_group_version() updates this same row.
    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET join_code = private.new_join_code(), updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_recode"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_recolor"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_color TEXT;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.recolor');
    v_color := private.cover_color(p_mutation);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET cover_color = v_color, updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_recolor"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_rename"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.rename');
    PERFORM private.require_name(p_mutation->>'name', 80, 'A group name');

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET name = btrim(p_mutation->>'name'), updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_rename"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_reopen"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.reopen');

    IF NOT EXISTS (SELECT 1 FROM public.groups WHERE id = v_group_id AND completed_at IS NOT NULL) THEN
        RETURN;
    END IF;

    -- Taken first: next_group_version() updates this same row.
    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET completed_at = NULL, completed_by_member_id = NULL, updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_reopen"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_group_sticker"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_sticker TEXT;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.sticker');
    v_sticker := private.cover_sticker(p_mutation);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET cover_sticker = v_sticker, updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

ALTER FUNCTION "private"."apply_group_sticker"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_invite_create"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_token TEXT := p_mutation->>'token';
    v_claim UUID := (p_mutation->>'claimMemberId')::UUID;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'invite.create');

    IF v_token IS NULL OR v_token !~ '^[A-Za-z0-9_-]{43}$' THEN
        RAISE EXCEPTION 'An invite token must be 32 random bytes in base64url' USING ERRCODE = 'HS422';
    END IF;
    IF v_claim IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.group_members
        WHERE id = v_claim AND group_id = v_group_id AND user_id IS NULL AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'An invite can only be for someone in this group who hasn''t joined' USING ERRCODE = 'HS422';
    END IF;

    INSERT INTO public.group_invites (id, group_id, token_hash, claim_member_id, created_by, expires_at, row_version)
    VALUES (
        (p_mutation->>'inviteId')::UUID,
        v_group_id,
        private.hash_token(v_token),
        v_claim,
        p_user,
        LEAST(COALESCE((p_mutation->>'expiresAt')::TIMESTAMPTZ, 'infinity'), NOW() + INTERVAL '14 days'),
        private.next_group_version(v_group_id)
    );
END;
$_$;

ALTER FUNCTION "private"."apply_invite_create"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_invite_revoke"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_invite public.group_invites;
BEGIN
    -- Whoever made the link may revoke it; anyone else's needs the owner. A link never stored is checked
    -- as your own.
    SELECT * INTO v_invite FROM public.group_invites WHERE id = (p_mutation->>'inviteId')::UUID;
    PERFORM private.require(p_user, v_group_id,
        CASE WHEN v_invite.id IS NULL OR v_invite.created_by = p_user THEN 'invite.revoke.own' ELSE 'invite.revoke.others' END);

    SELECT * INTO v_invite FROM public.group_invites WHERE id = (p_mutation->>'inviteId')::UUID;
    -- Its create never reached the server, or it is revoked already.
    IF v_invite.id IS NULL OR v_invite.revoked_at IS NOT NULL THEN
        RETURN;
    END IF;
    IF v_invite.group_id <> v_group_id THEN
        RAISE EXCEPTION 'That invite is for another group' USING ERRCODE = 'HS422';
    END IF;

    UPDATE public.group_invites SET revoked_at = NOW(), row_version = private.next_group_version(v_group_id)
    WHERE id = v_invite.id;
END;
$$;

ALTER FUNCTION "private"."apply_invite_revoke"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_member_add"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'member.add');
    PERFORM private.require_name(p_mutation->>'displayName', 60, 'A name');
    PERFORM private.require_unique_name(v_group_id, p_mutation->>'displayName', (p_mutation->>'memberId')::UUID);

    v_version := private.next_group_version(v_group_id);
    INSERT INTO public.group_members (id, group_id, display_name, role, row_version)
    VALUES ((p_mutation->>'memberId')::UUID, v_group_id, btrim(p_mutation->>'displayName'), 'member', v_version);
END;
$$;

ALTER FUNCTION "private"."apply_member_add"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_member_remove"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_target public.group_members;
    v_version BIGINT;
BEGIN
    v_me := private.caller_member(p_user, v_group_id);
    PERFORM private.require(p_user, v_group_id,
        CASE WHEN (p_mutation->>'memberId')::UUID = v_me.id THEN 'member.remove.self' ELSE 'member.remove.others' END);

    SELECT * INTO v_target
    FROM public.group_members
    WHERE id = (p_mutation->>'memberId')::UUID AND group_id = v_group_id;

    IF v_target.id IS NULL THEN
        RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
    END IF;
    IF v_target.deleted_at IS NOT NULL THEN
        RETURN;
    END IF;

    -- A group has one owner row: an owner who leaves stops being it.
    v_version := private.next_group_version(v_group_id);
    UPDATE public.group_members
    SET deleted_at = NOW(),
        role = CASE WHEN role = 'owner' THEN 'member' ELSE role END,
        updated_at = NOW(),
        row_version = v_version
    WHERE id = v_target.id;

    -- Someone gone from the group can't answer a handshake any more (005).
    PERFORM private.undo_pending_payments(v_target.id, v_version);

    -- Only the owner can remove the owner, so this is the owner leaving.
    IF v_target.role = 'owner' THEN
        PERFORM private.hand_over(v_group_id, v_version);
    END IF;
END;
$$;

ALTER FUNCTION "private"."apply_member_remove"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_member_rename"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_target UUID := (p_mutation->>'memberId')::UUID;
    v_me public.group_members;
    v_old TEXT;
    v_version BIGINT;
BEGIN
    v_me := private.caller_member(p_user, v_group_id);
    PERFORM private.require(p_user, v_group_id,
        CASE WHEN v_target = v_me.id THEN 'member.rename.self' ELSE 'member.rename.others' END);

    SELECT display_name INTO v_old FROM public.group_members WHERE id = v_target AND group_id = v_group_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
    END IF;
    PERFORM private.require_name(p_mutation->>'displayName', 60, 'A name');
    IF lower(btrim(v_old)) <> lower(btrim(p_mutation->>'displayName')) THEN
        PERFORM private.require_unique_name(v_group_id, p_mutation->>'displayName', v_target);
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.group_members
    SET display_name = btrim(p_mutation->>'displayName'), updated_at = NOW(), row_version = v_version
    WHERE id = v_target;
END;
$$;

ALTER FUNCTION "private"."apply_member_rename"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_mutation"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
DECLARE
    v_type TEXT := p_mutation->>'type';
    v_function TEXT;
BEGIN
    IF v_type ~ '^[a-z]+\.[a-z]+$' THEN
        v_function := 'apply_' || replace(v_type, '.', '_');
    END IF;

    IF v_function IS NULL OR to_regprocedure(format('private.%I(uuid, jsonb)', v_function)) IS NULL THEN
        RAISE EXCEPTION 'Unknown change type: %', v_type USING ERRCODE = 'HS422';
    END IF;

    EXECUTE format('SELECT private.%I($1, $2)', v_function) USING p_user, p_mutation;
END;
$_$;

ALTER FUNCTION "private"."apply_mutation"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_nudge_send"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_nudge_id UUID := (p_mutation->>'nudgeId')::UUID;
    v_me public.group_members;
    v_to public.group_members;
BEGIN
    v_me := private.require(p_user, v_group_id, 'nudge.send');

    -- A retry under a new mutation id: already stored, nothing to do.
    IF EXISTS (SELECT 1 FROM public.nudges WHERE id = v_nudge_id) THEN
        RETURN;
    END IF;

    SELECT * INTO v_to FROM public.group_members WHERE group_id = v_group_id AND id::TEXT = lower(p_mutation->>'toMemberId');
    IF v_to.id IS NULL THEN
        RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
    END IF;
    IF v_to.id = v_me.id THEN
        RAISE EXCEPTION 'You can''t nudge yourself' USING ERRCODE = 'HS422';
    END IF;
    IF v_to.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% left the group', v_to.display_name USING ERRCODE = 'HS422';
    END IF;
    IF NOT private.can_answer(v_to) THEN
        RAISE EXCEPTION '% hasn''t joined', v_to.display_name USING ERRCODE = 'HS422';
    END IF;
    IF private.debt_between(v_group_id, v_to.id, v_me.id) <= 0 THEN
        RAISE EXCEPTION '% doesn''t owe you anything', v_to.display_name USING ERRCODE = 'HS422';
    END IF;
    IF NOT private.is_cents(p_mutation->'amountCents', 1) THEN
        RAISE EXCEPTION 'The amount must be a whole number of cents from 1 to 10^12' USING ERRCODE = 'HS422';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.nudges n
        WHERE n.from_member_id = v_me.id AND n.to_member_id = v_to.id AND n.created_at > NOW() - INTERVAL '24 hours'
    ) THEN
        RAISE EXCEPTION 'You nudged % today', v_to.display_name USING ERRCODE = 'HS409';
    END IF;

    INSERT INTO public.nudges (id, group_id, from_member_id, to_member_id, amount_cents, row_version)
    VALUES (
        v_nudge_id, v_group_id, v_me.id, v_to.id, (p_mutation->>'amountCents')::NUMERIC::BIGINT,
        private.next_group_version(v_group_id)
    );
END;
$$;

ALTER FUNCTION "private"."apply_nudge_send"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_payment_confirm"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    SELECT private.answer_payment(p_user, p_mutation, TRUE);
$$;

ALTER FUNCTION "private"."apply_payment_confirm"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_payment_decline"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    SELECT private.answer_payment(p_user, p_mutation, FALSE);
$$;

ALTER FUNCTION "private"."apply_payment_decline"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_payment_record"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_sides RECORD;
    v_from public.group_members;
    v_to public.group_members;
    v_amount BIGINT;
    v_date DATE;
    v_answerer UUID;
    v_entry_id UUID := (p_mutation->>'entryId')::UUID;
    v_version BIGINT;
BEGIN
    v_me := private.caller_member(p_user, v_group_id);
    v_me := private.require(p_user, v_group_id,
        CASE WHEN v_me.id::TEXT IN (lower(p_mutation->>'fromMemberId'), lower(p_mutation->>'toMemberId'))
            THEN 'payment.record.own' ELSE 'payment.record.others' END);

    IF COALESCE(jsonb_typeof(p_mutation->'category'), 'null') <> 'null' THEN
        RAISE EXCEPTION 'A payment has no category' USING ERRCODE = 'HS422';
    END IF;
    v_sides := private.payment_sides(v_group_id, p_mutation);
    v_from := v_sides.from_member;
    v_to := v_sides.to_member;
    IF NOT private.may_record_payment(v_me.id, v_from, v_to) THEN
        RAISE EXCEPTION 'You can only record payments between two people who can''t answer them themselves' USING ERRCODE = 'HS422';
    END IF;
    v_amount := private.entry_amount(p_mutation)::BIGINT;
    BEGIN
        v_date := private.entry_date(p_mutation);
    EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'The date must be a real day' USING ERRCODE = 'HS422';
    END;
    PERFORM private.entry_notes(p_mutation);
    IF char_length(private.entry_description(p_mutation || '{"kind": "payment"}')) > 120 THEN
        RAISE EXCEPTION 'The description must be at most 120 characters' USING ERRCODE = 'HS422';
    END IF;
    PERFORM private.no_payment_waiting(v_group_id, v_from.id, v_to.id);

    v_answerer := private.payment_answerer(v_me.id, v_from, v_to);
    v_version := private.next_group_version(v_group_id);

    INSERT INTO public.ledger_entries (
        id, group_id, kind, description, amount_cents, entry_date, notes,
        payment_status, payer_confirmed_at, receiver_confirmed_at, confirmed_at,
        created_by_member_id, updated_by_member_id, row_version
    )
    VALUES (
        v_entry_id, v_group_id, 'payment', private.entry_description(p_mutation || '{"kind": "payment"}'),
        v_amount, v_date, p_mutation->>'notes',
        CASE WHEN v_answerer IS NULL THEN 'confirmed' ELSE 'pending' END,
        CASE WHEN v_me.id = v_from.id THEN NOW() END,
        CASE WHEN v_me.id = v_to.id THEN NOW() END,
        CASE WHEN v_answerer IS NULL THEN NOW() END,
        v_me.id, v_me.id, v_version
    );

    -- The person paying back "paid" it; the person receiving "owes" it to them (architecture §9.3).
    PERFORM private.write_shares(v_entry_id, v_group_id, jsonb_build_array(
        jsonb_build_object('memberId', v_from.id, 'paidCents', v_amount, 'owedCents', 0, 'owedTo', '{}'::JSONB),
        jsonb_build_object('memberId', v_to.id, 'paidCents', 0, 'owedCents', v_amount,
            'owedTo', jsonb_build_object(v_from.id::TEXT, v_amount))
    ));
END;
$$;

ALTER FUNCTION "private"."apply_payment_record"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."apply_payment_undo"("p_user" "uuid", "p_mutation" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
BEGIN
    v_me := private.require(p_user, v_group_id, 'payment.undo');
    v_entry := private.pending_payment(v_group_id, (p_mutation->>'entryId')::UUID);
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;
    IF v_entry.created_by_member_id <> v_me.id THEN
        RAISE EXCEPTION 'Only whoever recorded this payment can undo it' USING ERRCODE = 'HS403';
    END IF;

    UPDATE public.ledger_entries
    SET payment_status = 'undone', closed_at = NOW(),
        updated_by_member_id = v_me.id, updated_at = NOW(), row_version = private.next_group_version(v_group_id)
    WHERE id = v_entry.id;
END;
$$;

ALTER FUNCTION "private"."apply_payment_undo"("p_user" "uuid", "p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."bill_description"("p_entry" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF jsonb_typeof(p_entry->'description') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'The description must be text' USING ERRCODE = 'HS422';
    END IF;
    IF char_length(btrim(p_entry->>'description')) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'The description must be 1 to 120 characters' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."bill_description"("p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."bill_items"("p_items" "jsonb", "p_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
DECLARE
    v_items JSONB := COALESCE(p_items, 'null'::JSONB);
    v_item JSONB;
BEGIN
    IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION 'A bill needs 1 to 50 items' USING ERRCODE = 'HS422';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
        IF NOT private.is_cents(v_item->'amountCents', 1) THEN
            RAISE EXCEPTION 'Each item needs a whole amount of cents from 1 to 10^12' USING ERRCODE = 'HS422';
        END IF;
        IF v_item->>'description' IS NOT NULL
            AND (jsonb_typeof(v_item->'description') <> 'string' OR char_length(v_item->>'description') > 60) THEN
            RAISE EXCEPTION 'An item''s description must be text of at most 60 characters' USING ERRCODE = 'HS422';
        END IF;
        IF jsonb_typeof(v_item->'splitAmong') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'splitAmong') = 0 THEN
            RAISE EXCEPTION 'Each item needs someone to split it' USING ERRCODE = 'HS422';
        END IF;
        IF (SELECT count(DISTINCT lower(p #>> '{}')) <> count(*) FROM jsonb_array_elements(v_item->'splitAmong') p) THEN
            RAISE EXCEPTION 'Someone appears twice in an item''s split' USING ERRCODE = 'HS422';
        END IF;
    END LOOP;
    IF (SELECT sum((i->>'amountCents')::NUMERIC) FROM jsonb_array_elements(v_items) i) <> p_amount THEN
        RAISE EXCEPTION 'The items must add up to the amount' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."bill_items"("p_items" "jsonb", "p_amount" numeric) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."bill_people_in_group"("p_group_id" "uuid", "p_shares" "jsonb", "p_items" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM (
            SELECT s->>'memberId' FROM jsonb_array_elements(p_shares) s
            UNION ALL
            SELECT o.key FROM jsonb_array_elements(p_shares) s, jsonb_object_keys(s->'owedTo') o(key)
            UNION ALL
            SELECT i->>'paidBy' FROM jsonb_array_elements(p_items) i
            UNION ALL
            SELECT p #>> '{}' FROM jsonb_array_elements(p_items) i, jsonb_array_elements(i->'splitAmong') p
        ) AS named(person)
        WHERE person IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.id::TEXT = lower(person)
        )
    ) THEN
        RAISE EXCEPTION 'Everyone in a bill must be in this group' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."bill_people_in_group"("p_group_id" "uuid", "p_shares" "jsonb", "p_items" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."bill_shares"("p_shares" "jsonb", "p_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF jsonb_typeof(p_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(p_shares) = 0 THEN
        RAISE EXCEPTION 'A bill needs its shares' USING ERRCODE = 'HS422';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_shares) s
        WHERE NOT private.is_cents(s->'paidCents', 0) OR NOT private.is_cents(s->'owedCents', 0)
            OR jsonb_typeof(s->'owedTo') IS DISTINCT FROM 'object'
            OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(s->'owedTo') = 'object' THEN s->'owedTo' ELSE '{}' END) o
                WHERE NOT private.is_cents(o.value, 0))
    ) THEN
        RAISE EXCEPTION 'Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT count(DISTINCT lower(s->>'memberId')) <> count(*) FROM jsonb_array_elements(p_shares) s) THEN
        RAISE EXCEPTION 'Someone appears twice in the shares' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT sum((s->>'paidCents')::NUMERIC) <> p_amount OR sum((s->>'owedCents')::NUMERIC) <> p_amount
        FROM jsonb_array_elements(p_shares) s) THEN
        RAISE EXCEPTION 'The shares must add up to the amount' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."bill_shares"("p_shares" "jsonb", "p_amount" numeric) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."bill_shares_match_items"("p_shares" "jsonb", "p_items" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF EXISTS (
        (SELECT * FROM private.compute_shares(p_items) EXCEPT SELECT * FROM private.share_rows(p_shares))
        UNION ALL
        (SELECT * FROM private.share_rows(p_shares) EXCEPT SELECT * FROM private.compute_shares(p_items))
    ) THEN
        RAISE EXCEPTION 'The shares don''t match the items' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."bill_shares_match_items"("p_shares" "jsonb", "p_items" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."caller_member"("p_user" "uuid", "p_group_id" "uuid") RETURNS "public"."group_members"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT * FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user AND deleted_at IS NULL;
$$;

ALTER FUNCTION "private"."caller_member"("p_user" "uuid", "p_group_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."can_answer"("p_member" "public"."group_members") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT p_member.user_id IS NOT NULL AND p_member.deleted_at IS NULL;
$$;

ALTER FUNCTION "private"."can_answer"("p_member" "public"."group_members") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."compute_shares"("p_items" "jsonb") RETURNS TABLE("member_id" "uuid", "paid_cents" bigint, "owed_cents" bigint, "owed_to" "jsonb")
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
DECLARE
    v_ids UUID[];
    v_paid NUMERIC[];
    v_owed NUMERIC[];
    v_owed_to JSONB[];
    v_payer UUID;
    v_p INT;
    v_d NUMERIC;
    v_size INT;
    v_num NUMERIC[];
    v_part NUMERIC[];
    v_diff NUMERIC;
    v_short NUMERIC;
    v_k INT;
BEGIN
    WITH items AS (
        SELECT
            t.ord AS item_no,
            (t.item->>'amountCents')::NUMERIC AS amount,
            (t.item->>'paidBy')::UUID AS payer,
            t.item->'splitAmong' AS split
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(item, ord)
    ),
    appearances AS (
        SELECT (s.who #>> '{}')::UUID AS person, 0 AS late, i.item_no, s.pos
        FROM items i, jsonb_array_elements(i.split) WITH ORDINALITY AS s(who, pos)
        UNION ALL
        SELECT payer, 1, item_no, 0 FROM items
    ),
    people AS (
        SELECT DISTINCT ON (a.person) a.person, a.late, a.item_no, a.pos
        FROM appearances a
        ORDER BY a.person, a.late, a.item_no, a.pos
    )
    SELECT
        array_agg(p.person ORDER BY p.late, p.item_no, p.pos),
        array_agg(COALESCE((SELECT sum(i.amount) FROM items i WHERE i.payer = p.person), 0) ORDER BY p.late, p.item_no, p.pos)
    INTO v_ids, v_paid
    FROM people p;

    v_owed := array_fill(0::NUMERIC, ARRAY[cardinality(v_ids)]);
    v_owed_to := array_fill('{}'::JSONB, ARRAY[cardinality(v_ids)]);

    FOR v_payer IN SELECT DISTINCT (i.value->>'paidBy')::UUID FROM jsonb_array_elements(p_items) i LOOP
        v_p := array_position(v_ids, v_payer);

        v_d := 1;
        FOR v_size IN
            SELECT jsonb_array_length(i.value->'splitAmong') FROM jsonb_array_elements(p_items) i
            WHERE (i.value->>'paidBy')::UUID = v_payer
        LOOP
            v_d := lcm(v_d, v_size::NUMERIC);
        END LOOP;

        v_num := ARRAY(
            SELECT COALESCE((
                SELECT sum((i.value->>'amountCents')::NUMERIC * (v_d / jsonb_array_length(i.value->'splitAmong')))
                FROM jsonb_array_elements(p_items) i, jsonb_array_elements(i.value->'splitAmong') s
                WHERE (i.value->>'paidBy')::UUID = v_payer AND (s.value #>> '{}')::UUID = u.id
            ), 0)
            FROM unnest(v_ids) WITH ORDINALITY AS u(id, k)
            ORDER BY u.k
        );
        v_part := ARRAY(SELECT floor((2 * u.num + v_d) / (2 * v_d)) FROM unnest(v_num) WITH ORDINALITY AS u(num, k) ORDER BY u.k);
        v_diff := (SELECT sum((i.value->>'amountCents')::NUMERIC) FROM jsonb_array_elements(p_items) i WHERE (i.value->>'paidBy')::UUID = v_payer)
            - (SELECT sum(x) FROM unnest(v_part) AS x);

        IF v_part[v_p] + v_diff >= 0 THEN
            v_part[v_p] := v_part[v_p] + v_diff;
        ELSE
            v_short := -(v_part[v_p] + v_diff);
            v_part[v_p] := 0;
            FOR v_k IN
                SELECT u.k
                FROM unnest(v_part, v_num) WITH ORDINALITY AS u(part, num, k)
                WHERE u.k <> v_p
                ORDER BY u.part * v_d - u.num DESC, u.k
                LIMIT v_short::BIGINT
            LOOP
                v_part[v_k] := v_part[v_k] - 1;
            END LOOP;
        END IF;

        FOR v_k IN 1 .. cardinality(v_ids) LOOP
            IF v_part[v_k] > 0 THEN
                v_owed[v_k] := v_owed[v_k] + v_part[v_k];
                v_owed_to[v_k] := v_owed_to[v_k] || jsonb_build_object(v_payer::TEXT, v_part[v_k]::BIGINT);
            END IF;
        END LOOP;
    END LOOP;

    RETURN QUERY
    SELECT u.id, u.paid::BIGINT, u.owed::BIGINT, u.owed_to
    FROM unnest(v_ids, v_paid, v_owed, v_owed_to) WITH ORDINALITY AS u(id, paid, owed, owed_to, k)
    ORDER BY u.k;
END;
$$;

ALTER FUNCTION "private"."compute_shares"("p_items" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."cover_color"("p_mutation" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
DECLARE
    v_color TEXT := p_mutation->>'color';
BEGIN
    IF COALESCE(jsonb_typeof(p_mutation->'color'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_mutation->'color') <> 'string' OR v_color !~ '^h(1[0-7]|[0-9])s[0-4]$' THEN
        RAISE EXCEPTION 'That isn''t a colour on the board' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_color;
END;
$_$;

ALTER FUNCTION "private"."cover_color"("p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."cover_sticker"("p_mutation" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
DECLARE
    v_sticker TEXT := p_mutation->>'sticker';
BEGIN
    IF COALESCE(jsonb_typeof(p_mutation->'sticker'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_mutation->'sticker') <> 'string'
        OR char_length(v_sticker) > 120000
        OR NOT (
            v_sticker ~ '^hand:(food|drinks|stay|travel|groceries|fun|new)$'
            OR v_sticker ~ '^emoji:[^[:space:][:cntrl:]A-Za-z]{1,16}$'
            OR v_sticker ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
        ) THEN
        RAISE EXCEPTION 'That isn''t a sticker' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_sticker;
END;
$_$;

ALTER FUNCTION "private"."cover_sticker"("p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."debt_between"("p_group_id" "uuid", "p_from" "uuid", "p_to" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT COALESCE(sum(CASE WHEN p.member_id = p_from THEN p.owed_cents ELSE -p.owed_cents END), 0)::BIGINT
    FROM public.ledger_share_parts p
    JOIN public.ledger_entries e ON e.id = p.entry_id AND private.entry_counts(e)
    WHERE p.group_id = p_group_id
        AND ((p.member_id = p_from AND p.payer_member_id = p_to) OR (p.member_id = p_to AND p.payer_member_id = p_from));
$$;

ALTER FUNCTION "private"."debt_between"("p_group_id" "uuid", "p_from" "uuid", "p_to" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."delete_entry"("p_entry_id" "uuid", "p_member_id" "uuid", "p_version" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    UPDATE public.ledger_entries
    SET deleted_at = COALESCE(deleted_at, NOW()), updated_by_member_id = p_member_id, updated_at = NOW(), row_version = p_version
    WHERE id = p_entry_id;

    PERFORM private.record_entry_version(p_entry_id);
END;
$$;

ALTER FUNCTION "private"."delete_entry"("p_entry_id" "uuid", "p_member_id" "uuid", "p_version" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."drop_guest_code"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    UPDATE public.guest_codes SET deleted_at = NOW(), row_version = NEW.row_version
    WHERE member_id = NEW.id AND deleted_at IS NULL;
    RETURN NULL;
END;
$$;

ALTER FUNCTION "private"."drop_guest_code"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_amount"("p_entry" "jsonb") RETURNS numeric
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF NOT private.is_cents(p_entry->'amountCents', 1) THEN
        RAISE EXCEPTION 'The amount must be a whole number of cents from 1 to 10^12' USING ERRCODE = 'HS422';
    END IF;
    RETURN (p_entry->>'amountCents')::NUMERIC;
END;
$$;

ALTER FUNCTION "private"."entry_amount"("p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_category"("p_entry" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF COALESCE(jsonb_typeof(p_entry->'category'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_entry->'category') <> 'string'
        OR p_entry->>'category' NOT IN ('food', 'drinks', 'stay', 'travel', 'groceries', 'fun') THEN
        RAISE EXCEPTION 'The category must be food, drinks, stay, travel, groceries or fun' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_entry->>'category';
END;
$$;

ALTER FUNCTION "private"."entry_category"("p_entry" "jsonb") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."ledger_entries" (
    "id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "items" "jsonb",
    "entry_date" "date" NOT NULL,
    "notes" "text",
    "payment_status" "text",
    "payer_confirmed_at" timestamp with time zone,
    "receiver_confirmed_at" timestamp with time zone,
    "confirmed_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "close_note" "text",
    "created_by_member_id" "uuid" NOT NULL,
    "updated_by_member_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "row_version" bigint DEFAULT 0 NOT NULL,
    "category" "text",
    CONSTRAINT "ledger_entries_amount_cents_check" CHECK ((("amount_cents" >= 1) AND ("amount_cents" <= '1000000000000'::bigint))),
    CONSTRAINT "ledger_entries_category_check" CHECK (("category" = ANY (ARRAY['food'::"text", 'drinks'::"text", 'stay'::"text", 'travel'::"text", 'groceries'::"text", 'fun'::"text"]))),
    CONSTRAINT "ledger_entries_check" CHECK ((("kind" = 'expense'::"text") = ("items" IS NOT NULL))),
    CONSTRAINT "ledger_entries_check1" CHECK ((("kind" = 'expense'::"text") = ("payment_status" IS NULL))),
    CONSTRAINT "ledger_entries_close_note_check" CHECK (("char_length"("close_note") <= 200)),
    CONSTRAINT "ledger_entries_description_check" CHECK ((("char_length"("description") >= 1) AND ("char_length"("description") <= 120))),
    CONSTRAINT "ledger_entries_kind_check" CHECK (("kind" = ANY (ARRAY['expense'::"text", 'payment'::"text"]))),
    CONSTRAINT "ledger_entries_notes_check" CHECK (("char_length"("notes") <= 1000)),
    CONSTRAINT "ledger_entries_payment_category_check" CHECK ((("kind" = 'expense'::"text") OR ("category" IS NULL))),
    CONSTRAINT "ledger_entries_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'declined'::"text", 'undone'::"text"])))
);

ALTER TABLE "public"."ledger_entries" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_counts"("p_entry" "public"."ledger_entries") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT CASE WHEN p_entry.kind = 'expense' THEN p_entry.deleted_at IS NULL ELSE p_entry.payment_status = 'confirmed' END;
$$;

ALTER FUNCTION "private"."entry_counts"("p_entry" "public"."ledger_entries") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_date"("p_entry" "jsonb") RETURNS "date"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $_$
BEGIN
    IF COALESCE(p_entry->>'entryDate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'The date must be YYYY-MM-DD' USING ERRCODE = 'HS422';
    END IF;
    RETURN (p_entry->>'entryDate')::DATE;
END;
$_$;

ALTER FUNCTION "private"."entry_date"("p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_description"("p_entry" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT CASE WHEN p_entry->>'kind' = 'payment'
        THEN COALESCE(NULLIF(btrim(p_entry->>'description'), ''), 'Payment')
        ELSE btrim(p_entry->>'description') END;
$$;

ALTER FUNCTION "private"."entry_description"("p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_notes"("p_entry" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF p_entry->>'notes' IS NOT NULL AND (jsonb_typeof(p_entry->'notes') <> 'string' OR char_length(p_entry->>'notes') > 1000) THEN
        RAISE EXCEPTION 'Notes must be text of at most 1000 characters' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_entry->>'notes';
END;
$$;

ALTER FUNCTION "private"."entry_notes"("p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_proposal"("p_entry" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'description', btrim(p_entry->>'description'),
        'amountCents', (p_entry->>'amountCents')::NUMERIC::BIGINT,
        'entryDate', (p_entry->>'entryDate')::DATE,
        'notes', p_entry->>'notes',
        'category', private.entry_category(p_entry),
        'items', p_entry->'items',
        'shares', (
            SELECT jsonb_agg(jsonb_build_object(
                'memberId', s.member_id,
                'paidCents', s.paid_cents,
                'owedCents', s.owed_cents,
                'owedTo', s.owed_to
            ) ORDER BY s.member_id)
            FROM private.share_rows(p_entry->'shares') s
        ),
        'deletedAt', NULL
    );
$$;

ALTER FUNCTION "private"."entry_proposal"("p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."entry_snapshot"("p_entry_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'description', e.description,
        'amountCents', e.amount_cents,
        'entryDate', e.entry_date,
        'notes', e.notes,
        'category', e.category,
        'items', e.items,
        'shares', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'memberId', s.member_id,
                'paidCents', s.paid_cents,
                'owedCents', s.owed_cents,
                'owedTo', COALESCE((
                    SELECT jsonb_object_agg(p.payer_member_id, p.owed_cents)
                    FROM public.ledger_share_parts p
                    WHERE p.entry_id = s.entry_id AND p.member_id = s.member_id
                ), '{}'::JSONB)
            ) ORDER BY s.member_id)
            FROM public.ledger_shares s
            WHERE s.entry_id = e.id
        ), '[]'::JSONB),
        'deletedAt', e.deleted_at,
        'rowVersion', e.row_version,
        'updatedByMemberId', e.updated_by_member_id
    )
    FROM public.ledger_entries e
    WHERE e.id = p_entry_id;
$$;

ALTER FUNCTION "private"."entry_snapshot"("p_entry_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."find_group_by_code"("p_code" "text") RETURNS "public"."groups"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group public.groups;
BEGIN
    SELECT * INTO v_group FROM public.groups
    WHERE join_code = private.normalise_code(p_code) AND deleted_at IS NULL AND completed_at IS NULL;

    IF v_group.id IS NULL THEN
        RAISE EXCEPTION 'This code doesn''t work' USING ERRCODE = 'HS404';
    END IF;
    RETURN v_group;
END;
$$;

ALTER FUNCTION "private"."find_group_by_code"("p_code" "text") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."group_invites" (
    "id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "claim_member_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "row_version" bigint DEFAULT 0 NOT NULL
);

ALTER TABLE "public"."group_invites" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."find_invite"("p_token" "text") RETURNS "public"."group_invites"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
DECLARE
    v_invite public.group_invites;
BEGIN
    SELECT i.* INTO v_invite
    FROM public.group_invites i
    JOIN public.groups g ON g.id = i.group_id
    WHERE i.token_hash = private.hash_token(p_token)
        AND i.revoked_at IS NULL
        AND i.expires_at > NOW()
        AND g.deleted_at IS NULL
        AND g.completed_at IS NULL;

    IF v_invite.id IS NULL THEN
        RAISE EXCEPTION 'This invite link doesn''t work any more' USING ERRCODE = 'HS404';
    END IF;
    RETURN v_invite;
END;
$$;

ALTER FUNCTION "private"."find_invite"("p_token" "text") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."guest_codes" (
    "member_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "row_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "guest_codes_code_check" CHECK (("code" ~ '^[A-HJKMNP-Z2-9]{8}$'::"text"))
);

ALTER TABLE "public"."guest_codes" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."find_personal_code"("p_code" "text") RETURNS "public"."guest_codes"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
DECLARE
    v_code public.guest_codes;
BEGIN
    SELECT c.* INTO v_code
    FROM public.guest_codes c
    JOIN public.groups g ON g.id = c.group_id
    JOIN public.group_members gm ON gm.id = c.member_id
    WHERE c.code = private.normalise_code(p_code)
        AND c.deleted_at IS NULL
        AND g.deleted_at IS NULL
        AND g.completed_at IS NULL
        AND gm.deleted_at IS NULL
        AND gm.user_id IS NOT NULL;

    IF v_code.member_id IS NULL THEN
        RAISE EXCEPTION 'This code doesn''t work' USING ERRCODE = 'HS404';
    END IF;
    RETURN v_code;
END;
$$;

ALTER FUNCTION "private"."find_personal_code"("p_code" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."give_guest_code"("p_group_id" "uuid", "p_member_id" "uuid", "p_version" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.guest_codes WHERE member_id = p_member_id AND deleted_at IS NULL) THEN
        RETURN;
    END IF;
    INSERT INTO public.guest_codes (member_id, group_id, code, row_version)
    VALUES (p_member_id, p_group_id, private.new_personal_code(), p_version)
    ON CONFLICT (member_id) DO UPDATE
    SET code = EXCLUDED.code, created_at = NOW(), deleted_at = NULL, row_version = EXCLUDED.row_version;
END;
$$;

ALTER FUNCTION "private"."give_guest_code"("p_group_id" "uuid", "p_member_id" "uuid", "p_version" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."group_note"("p_mutation" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
DECLARE
    v_note TEXT;
BEGIN
    IF COALESCE(jsonb_typeof(p_mutation->'note'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_mutation->'note') <> 'string' THEN
        RAISE EXCEPTION 'A group note must be text' USING ERRCODE = 'HS422';
    END IF;
    v_note := NULLIF(btrim(p_mutation->>'note'), '');
    IF char_length(v_note) > 120 THEN
        RAISE EXCEPTION 'A group note must be at most 120 characters' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_note;
END;
$$;

ALTER FUNCTION "private"."group_note"("p_mutation" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."hand_over"("p_group_id" "uuid", "p_version" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    UPDATE public.group_members SET role = 'owner', updated_at = NOW(), row_version = p_version
    WHERE id = (
        SELECT id FROM public.group_members
        WHERE group_id = p_group_id AND role = 'member' AND user_id IS NOT NULL AND deleted_at IS NULL
        ORDER BY joined_at, id
        LIMIT 1
    );

    IF NOT FOUND THEN
        UPDATE public.groups SET deleted_at = NOW(), updated_at = NOW(), row_version = p_version
        WHERE id = p_group_id AND deleted_at IS NULL;
    ELSE
        UPDATE public.guest_codes SET row_version = p_version WHERE group_id = p_group_id;
    END IF;
END;
$$;

ALTER FUNCTION "private"."hand_over"("p_group_id" "uuid", "p_version" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.email, ''),
        LEFT(COALESCE(
            NULLIF(btrim(NEW.raw_user_meta_data->>'display_name'), ''),
            NULLIF(split_part(NEW.email, '@', 1), ''),
            'Friend'
        ), 60)
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

ALTER FUNCTION "private"."handle_new_user"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."hash_token"("p_token" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

ALTER FUNCTION "private"."hash_token"("p_token" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."is_anonymous"() RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT COALESCE((auth.jwt()->>'is_anonymous')::BOOLEAN, FALSE);
$$;

ALTER FUNCTION "private"."is_anonymous"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."is_cents"("p_value" "jsonb", "p_min" numeric) RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'number' THEN
        (p_value #>> '{}')::NUMERIC = trunc((p_value #>> '{}')::NUMERIC)
        AND (p_value #>> '{}')::NUMERIC BETWEEN p_min AND 1000000000000
    ELSE FALSE END;
$$;

ALTER FUNCTION "private"."is_cents"("p_value" "jsonb", "p_min" numeric) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."is_stale"("p_mutation" "jsonb", "p_entry" "public"."ledger_entries", "p_member_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF NOT private.is_cents(p_mutation->'baseVersion', 0) THEN
        RAISE EXCEPTION 'baseVersion must be the entry''s version the change started from' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_entry.row_version > (p_mutation->>'baseVersion')::NUMERIC AND p_entry.updated_by_member_id <> p_member_id;
END;
$$;

ALTER FUNCTION "private"."is_stale"("p_mutation" "jsonb", "p_entry" "public"."ledger_entries", "p_member_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."may"("p_action" "text", "p_role" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT COALESCE(CASE p_action
        WHEN 'group.rename' THEN p_role = 'owner'
        WHEN 'group.delete' THEN p_role = 'owner'
        WHEN 'group.complete' THEN p_role = 'owner'
        WHEN 'group.reopen' THEN p_role = 'owner'
        WHEN 'group.recode' THEN p_role = 'owner'
        WHEN 'group.recolor' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'group.sticker' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'member.add' THEN p_role IN ('owner', 'member')
        WHEN 'member.rename.self' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'member.rename.others' THEN p_role = 'owner'
        WHEN 'member.remove.self' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'member.remove.others' THEN p_role = 'owner'
        WHEN 'entry.create' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'entry.update' THEN p_role IN ('owner', 'member')
        WHEN 'entry.delete.own' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'entry.delete.others' THEN p_role IN ('owner', 'member')
        WHEN 'conflict.resolve' THEN p_role IN ('owner', 'member')
        WHEN 'invite.create' THEN p_role IN ('owner', 'member')
        WHEN 'invite.revoke.own' THEN p_role IN ('owner', 'member')
        WHEN 'invite.revoke.others' THEN p_role = 'owner'
        WHEN 'payment.record.own' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'payment.record.others' THEN p_role IN ('owner', 'member')
        WHEN 'payment.respond' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'payment.undo' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'nudge.send' THEN p_role IN ('owner', 'member', 'guest')
    END, FALSE);
$$;

ALTER FUNCTION "private"."may"("p_action" "text", "p_role" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."may_record_payment"("p_recorder_id" "uuid", "p_from" "public"."group_members", "p_to" "public"."group_members") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT p_recorder_id IN (p_from.id, p_to.id) OR NOT (private.can_answer(p_from) OR private.can_answer(p_to));
$$;

ALTER FUNCTION "private"."may_record_payment"("p_recorder_id" "uuid", "p_from" "public"."group_members", "p_to" "public"."group_members") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."new_personal_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_code TEXT;
BEGIN
    LOOP
        v_code := private.random_code(8);
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.guest_codes WHERE code = v_code AND deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM public.groups WHERE join_code = v_code);
    END LOOP;
    RETURN v_code;
END;
$$;

ALTER FUNCTION "private"."new_personal_code"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."next_group_version"("p_group_id" "uuid") RETURNS bigint
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
    UPDATE public.groups SET head_version = head_version + 1 WHERE id = p_group_id RETURNING head_version;
$$;

ALTER FUNCTION "private"."next_group_version"("p_group_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."no_payment_waiting"("p_group_id" "uuid", "p_a" "uuid", "p_b" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.ledger_entries e
        WHERE e.group_id = p_group_id AND e.payment_status = 'pending'
            AND (SELECT count(*) FROM public.ledger_shares s WHERE s.entry_id = e.id AND s.member_id IN (p_a, p_b)) = 2
    ) THEN
        RAISE EXCEPTION 'A payment between these two is already waiting for an answer' USING ERRCODE = 'HS409';
    END IF;
END;
$$;

ALTER FUNCTION "private"."no_payment_waiting"("p_group_id" "uuid", "p_a" "uuid", "p_b" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."normalise_code"("p_code" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT upper(regexp_replace(COALESCE(p_code, ''), '[\s-]', '', 'g'));
$$;

ALTER FUNCTION "private"."normalise_code"("p_code" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."open_conflict"("p_mutation" "jsonb", "p_entry" "public"."ledger_entries", "p_member_id" "uuid", "p_version" bigint, "p_proposed" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_base_version BIGINT := (p_mutation->>'baseVersion')::NUMERIC::BIGINT;
BEGIN
    INSERT INTO public.entry_conflicts (
        id, group_id, entry_id, base_version, base, proposed, proposed_by_member_id, row_version
    )
    VALUES (
        (p_mutation->>'id')::UUID,
        p_entry.group_id,
        p_entry.id,
        v_base_version,
        (SELECT snapshot FROM public.ledger_entry_versions WHERE entry_id = p_entry.id AND row_version = v_base_version),
        p_proposed,
        p_member_id,
        p_version
    );
END;
$$;

ALTER FUNCTION "private"."open_conflict"("p_mutation" "jsonb", "p_entry" "public"."ledger_entries", "p_member_id" "uuid", "p_version" bigint, "p_proposed" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."payment_answerer"("p_recorder_id" "uuid", "p_from" "public"."group_members", "p_to" "public"."group_members") RETURNS "uuid"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT CASE WHEN p_recorder_id = p_from.id AND private.can_answer(p_to) THEN p_to.id END;
$$;

ALTER FUNCTION "private"."payment_answerer"("p_recorder_id" "uuid", "p_from" "public"."group_members", "p_to" "public"."group_members") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."payment_sides"("p_entry_id" "uuid", OUT "from_member_id" "uuid", OUT "to_member_id" "uuid") RETURNS "record"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT
        (SELECT s.member_id FROM public.ledger_shares s WHERE s.entry_id = p_entry_id AND s.paid_cents > 0),
        (SELECT s.member_id FROM public.ledger_shares s WHERE s.entry_id = p_entry_id AND s.owed_cents > 0);
$$;

ALTER FUNCTION "private"."payment_sides"("p_entry_id" "uuid", OUT "from_member_id" "uuid", OUT "to_member_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."payment_sides"("p_group_id" "uuid", "p_mutation" "jsonb", OUT "from_member" "public"."group_members", OUT "to_member" "public"."group_members") RETURNS "record"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    SELECT * INTO from_member FROM public.group_members WHERE group_id = p_group_id AND id::TEXT = lower(p_mutation->>'fromMemberId');
    SELECT * INTO to_member FROM public.group_members WHERE group_id = p_group_id AND id::TEXT = lower(p_mutation->>'toMemberId');
    IF from_member.id IS NULL OR to_member.id IS NULL THEN
        RAISE EXCEPTION 'Both sides of a payment must be in this group' USING ERRCODE = 'HS422';
    END IF;
    IF from_member.id = to_member.id THEN
        RAISE EXCEPTION 'A payment is between two different people' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."payment_sides"("p_group_id" "uuid", "p_mutation" "jsonb", OUT "from_member" "public"."group_members", OUT "to_member" "public"."group_members") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."pending_payment"("p_group_id" "uuid", "p_entry_id" "uuid") RETURNS "public"."ledger_entries"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_entry public.ledger_entries;
BEGIN
    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = p_entry_id;
    IF v_entry.id IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_entry.group_id <> p_group_id THEN
        RAISE EXCEPTION 'That payment is in another group' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.kind <> 'payment' THEN
        RAISE EXCEPTION 'That is a bill, not a payment' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.payment_status <> 'pending' THEN
        RAISE EXCEPTION 'This payment is already %', v_entry.payment_status USING ERRCODE = 'HS409';
    END IF;
    RETURN v_entry;
END;
$$;

ALTER FUNCTION "private"."pending_payment"("p_group_id" "uuid", "p_entry_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."random_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    v_code TEXT := '';
    v_byte INT;
BEGIN
    WHILE length(v_code) < 6 LOOP
        v_byte := get_byte(extensions.gen_random_bytes(1), 0);
        IF v_byte < 248 THEN
            v_code := v_code || substr(v_alphabet, v_byte % 31 + 1, 1);
        END IF;
    END LOOP;
    RETURN v_code;
END;
$$;

ALTER FUNCTION "private"."random_code"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."random_code"("p_length" integer) RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    v_code TEXT := '';
    v_byte INT;
BEGIN
    WHILE length(v_code) < p_length LOOP
        v_byte := get_byte(extensions.gen_random_bytes(1), 0);
        IF v_byte < 248 THEN
            v_code := v_code || substr(v_alphabet, v_byte % 31 + 1, 1);
        END IF;
    END LOOP;
    RETURN v_code;
END;
$$;

ALTER FUNCTION "private"."random_code"("p_length" integer) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."record_entry_version"("p_entry_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    INSERT INTO public.ledger_entry_versions (entry_id, row_version, snapshot)
    SELECT e.id, e.row_version, private.entry_snapshot(e.id) FROM public.ledger_entries e WHERE e.id = p_entry_id
    ON CONFLICT (entry_id, row_version) DO UPDATE SET snapshot = EXCLUDED.snapshot;

    DELETE FROM public.ledger_entry_versions
    WHERE entry_id = p_entry_id AND row_version < (
        SELECT min(v.row_version) FROM (
            SELECT row_version FROM public.ledger_entry_versions
            WHERE entry_id = p_entry_id
            ORDER BY row_version DESC
            LIMIT 20
        ) v
    );
END;
$$;

ALTER FUNCTION "private"."record_entry_version"("p_entry_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."renew_short_guest_codes"() RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group_id UUID;
    v_version BIGINT;
    v_member_id UUID;
BEGIN
    FOR v_group_id IN SELECT DISTINCT group_id FROM public.guest_codes WHERE length(code) <> 8 ORDER BY group_id LOOP
        v_version := private.next_group_version(v_group_id);
        FOR v_member_id IN
            SELECT member_id FROM public.guest_codes WHERE group_id = v_group_id AND length(code) <> 8 ORDER BY member_id
        LOOP
            UPDATE public.guest_codes SET code = private.new_personal_code(), row_version = v_version
            WHERE member_id = v_member_id;
        END LOOP;
    END LOOP;
END;
$$;

ALTER FUNCTION "private"."renew_short_guest_codes"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."require"("p_user" "uuid", "p_group_id" "uuid", "p_action" "text") RETURNS "public"."group_members"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group public.groups;
    v_member public.group_members;
BEGIN
    SELECT * INTO v_group FROM public.groups WHERE id = p_group_id FOR NO KEY UPDATE;
    v_member := private.caller_member(p_user, p_group_id);

    IF v_member.id IS NULL THEN
        RAISE EXCEPTION 'You are not a member of this group' USING ERRCODE = 'HS403';
    END IF;
    IF v_group.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'This group was deleted' USING ERRCODE = 'HS403';
    END IF;
    IF v_group.completed_at IS NOT NULL AND NOT private.allowed_when_completed(p_action) THEN
        RAISE EXCEPTION 'This group is completed' USING ERRCODE = 'HS403';
    END IF;
    IF NOT private.may(p_action, v_member.role) THEN
        RAISE EXCEPTION '%', CASE WHEN private.may(p_action, 'owner') AND NOT private.may(p_action, 'member')
            THEN 'Only the group''s owner can do this' ELSE 'Guests can''t do this' END
            USING ERRCODE = 'HS403';
    END IF;

    RETURN v_member;
END;
$$;

ALTER FUNCTION "private"."require"("p_user" "uuid", "p_group_id" "uuid", "p_action" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."require_account"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
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

ALTER FUNCTION "private"."require_account"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."require_name"("p_name" "text", "p_max" integer, "p_what" "text") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND p_max THEN
        RAISE EXCEPTION '% must be 1 to % characters', p_what, p_max USING ERRCODE = 'HS422';
    END IF;
END;
$$;

ALTER FUNCTION "private"."require_name"("p_name" "text", "p_max" integer, "p_what" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."require_unique_name"("p_group_id" "uuid", "p_name" "text", "p_except" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.group_members
        WHERE group_id = p_group_id
            AND deleted_at IS NULL
            AND id IS DISTINCT FROM p_except
            AND lower(btrim(display_name)) = lower(btrim(p_name))
    ) THEN
        RAISE EXCEPTION '% is already in this group', btrim(p_name) USING ERRCODE = 'HS409';
    END IF;
END;
$$;

ALTER FUNCTION "private"."require_unique_name"("p_group_id" "uuid", "p_name" "text", "p_except" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."save_entry"("p_entry_id" "uuid", "p_group_id" "uuid", "p_entry" "jsonb", "p_member_id" "uuid", "p_version" bigint, "p_is_new" boolean) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_category TEXT := private.entry_category(p_entry);
BEGIN
    IF p_is_new THEN
        INSERT INTO public.ledger_entries (
            id, group_id, kind, description, amount_cents, items, entry_date, notes, category,
            created_by_member_id, updated_by_member_id, row_version
        )
        VALUES (
            p_entry_id, p_group_id, 'expense', btrim(p_entry->>'description'),
            (p_entry->>'amountCents')::NUMERIC::BIGINT, p_entry->'items', (p_entry->>'entryDate')::DATE, p_entry->>'notes',
            v_category, p_member_id, p_member_id, p_version
        );
    ELSE
        UPDATE public.ledger_entries
        SET description = btrim(p_entry->>'description'),
            amount_cents = (p_entry->>'amountCents')::NUMERIC::BIGINT,
            items = p_entry->'items',
            entry_date = (p_entry->>'entryDate')::DATE,
            notes = p_entry->>'notes',
            category = v_category,
            updated_by_member_id = p_member_id,
            updated_at = NOW(),
            deleted_at = NULL,
            row_version = p_version
        WHERE id = p_entry_id;
    END IF;

    PERFORM private.write_shares(p_entry_id, p_group_id, p_entry->'shares');
    PERFORM private.record_entry_version(p_entry_id);
END;
$$;

ALTER FUNCTION "private"."save_entry"("p_entry_id" "uuid", "p_group_id" "uuid", "p_entry" "jsonb", "p_member_id" "uuid", "p_version" bigint, "p_is_new" boolean) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."share_rows"("p_shares" "jsonb") RETURNS TABLE("member_id" "uuid", "paid_cents" bigint, "owed_cents" bigint, "owed_to" "jsonb")
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT
        lower(s->>'memberId')::UUID,
        (s->>'paidCents')::NUMERIC::BIGINT,
        (s->>'owedCents')::NUMERIC::BIGINT,
        COALESCE((
            SELECT jsonb_object_agg(lower(o.key), (o.value #>> '{}')::NUMERIC::BIGINT)
            FROM jsonb_each(s->'owedTo') o
            WHERE (o.value #>> '{}')::NUMERIC > 0
        ), '{}'::JSONB)
    FROM jsonb_array_elements(p_shares) s;
$$;

ALTER FUNCTION "private"."share_rows"("p_shares" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."stored_bill"("p_group_id" "uuid", "p_entry_id" "uuid") RETURNS "public"."ledger_entries"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_entry public.ledger_entries;
BEGIN
    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = p_entry_id;
    IF v_entry.id IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_entry.group_id <> p_group_id THEN
        RAISE EXCEPTION 'That entry is in another group' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.kind = 'payment' THEN
        RAISE EXCEPTION 'A payment can''t be edited or deleted; record one the other way instead' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_entry;
END;
$$;

ALTER FUNCTION "private"."stored_bill"("p_group_id" "uuid", "p_entry_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."undo_pending_payments"("p_member_id" "uuid", "p_version" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    UPDATE public.ledger_entries e
    SET payment_status = 'undone', closed_at = NOW(),
        updated_by_member_id = p_member_id, updated_at = NOW(), row_version = p_version
    WHERE e.payment_status = 'pending'
        AND EXISTS (SELECT 1 FROM public.ledger_shares s WHERE s.entry_id = e.id AND s.member_id = p_member_id);
END;
$$;

ALTER FUNCTION "private"."undo_pending_payments"("p_member_id" "uuid", "p_version" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."validate_entry"("p_group_id" "uuid", "p_entry" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    v_kind TEXT := COALESCE(p_entry->>'kind', 'expense');
    v_amount NUMERIC;
BEGIN
    IF v_kind = 'payment' THEN
        RAISE EXCEPTION 'Payments are recorded with payment.record' USING ERRCODE = 'HS422';
    END IF;
    IF v_kind <> 'expense' THEN
        RAISE EXCEPTION 'An entry is a bill (expense) or a payment' USING ERRCODE = 'HS422';
    END IF;
    PERFORM private.bill_description(p_entry);
    v_amount := private.entry_amount(p_entry);
    PERFORM private.entry_date(p_entry);
    PERFORM private.entry_notes(p_entry);
    PERFORM private.bill_shares(p_entry->'shares', v_amount);
    PERFORM private.bill_items(p_entry->'items', v_amount);
    PERFORM private.bill_people_in_group(p_group_id, p_entry->'shares', p_entry->'items');
    PERFORM private.bill_shares_match_items(p_entry->'shares', p_entry->'items');
EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'The entry has a malformed value: %', SQLERRM USING ERRCODE = 'HS422';
END;
$$;

ALTER FUNCTION "private"."validate_entry"("p_group_id" "uuid", "p_entry" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "private"."write_shares"("p_entry_id" "uuid", "p_group_id" "uuid", "p_shares" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    DELETE FROM public.ledger_shares WHERE entry_id = p_entry_id;
    INSERT INTO public.ledger_shares (entry_id, group_id, member_id, paid_cents, owed_cents)
    SELECT p_entry_id, p_group_id, s.member_id, s.paid_cents, s.owed_cents FROM private.share_rows(p_shares) s;
    INSERT INTO public.ledger_share_parts (entry_id, group_id, member_id, payer_member_id, owed_cents)
    SELECT p_entry_id, p_group_id, s.member_id, o.key::UUID, (o.value #>> '{}')::BIGINT
    FROM private.share_rows(p_shares) s, jsonb_each(s.owed_to) o;
END;
$$;

ALTER FUNCTION "private"."write_shares"("p_entry_id" "uuid", "p_group_id" "uuid", "p_shares" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."create_api_token"("p_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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

ALTER FUNCTION "public"."create_api_token"("p_name" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."delete_account"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_row public.group_members;
    v_version BIGINT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;

    FOR v_row IN SELECT gm.* FROM public.group_members gm WHERE gm.user_id = v_user ORDER BY gm.group_id LOOP
        v_version := private.next_group_version(v_row.group_id);

        PERFORM private.undo_pending_payments(v_row.id, v_version);

        UPDATE public.group_members
        SET user_id = NULL, role = 'member', joined_at = NULL, updated_at = NOW(), row_version = v_version
        WHERE id = v_row.id;

        IF v_row.role = 'owner' AND v_row.deleted_at IS NULL THEN
            PERFORM private.hand_over(v_row.group_id, v_version);
        END IF;
    END LOOP;

    -- Cascades to their profile, sync_mutations and API tokens (009), so Pholio's connection stops.
    DELETE FROM auth.users WHERE id = v_user;
END;
$$;

ALTER FUNCTION "public"."delete_account"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."is_group_member"("p_group_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.group_members
        WHERE group_id = p_group_id AND user_id = (SELECT auth.uid()) AND deleted_at IS NULL
    );
$$;

ALTER FUNCTION "public"."is_group_member"("p_group_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."join_group"("p_token" "text", "p_claim_member_id" "uuid" DEFAULT NULL::"uuid", "p_display_name" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_role TEXT := CASE WHEN private.is_anonymous() THEN 'guest' ELSE 'member' END;
    v_invite public.group_invites;
    v_mine public.group_members;
    v_claim public.group_members;
    v_version BIGINT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;

    v_invite := private.find_invite(p_token);
    PERFORM 1 FROM public.groups WHERE id = v_invite.group_id FOR NO KEY UPDATE;
    -- Again, now that the group is locked: it may have been revoked or completed meanwhile.
    v_invite := private.find_invite(p_token);

    SELECT * INTO v_mine FROM public.group_members WHERE group_id = v_invite.group_id AND user_id = v_user;
    IF v_mine.id IS NOT NULL AND v_mine.deleted_at IS NULL THEN
        RETURN v_invite.group_id;
    END IF;

    IF v_mine.id IS NULL THEN
        SELECT * INTO v_claim FROM public.group_members
        WHERE id = COALESCE(p_claim_member_id, v_invite.claim_member_id) AND group_id = v_invite.group_id;

        IF p_claim_member_id IS NOT NULL THEN
            IF v_claim.id IS NULL OR v_claim.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
            END IF;
            IF v_claim.user_id IS NOT NULL THEN
                RAISE EXCEPTION 'Someone has already joined as that person' USING ERRCODE = 'HS422';
            END IF;
        ELSIF v_claim.user_id IS NOT NULL OR v_claim.deleted_at IS NOT NULL THEN
            -- The link's non-member has joined or left since: add the caller as someone new instead.
            v_claim := NULL;
        END IF;
    END IF;

    v_version := private.next_group_version(v_invite.group_id);

    IF v_mine.id IS NOT NULL THEN
        UPDATE public.group_members
        SET deleted_at = NULL, role = v_role, joined_at = NOW(), updated_at = NOW(), row_version = v_version
        WHERE id = v_mine.id;
    ELSIF v_claim.id IS NOT NULL THEN
        UPDATE public.group_members
        SET user_id = v_user, role = v_role, joined_at = NOW(), updated_at = NOW(), row_version = v_version
        WHERE id = v_claim.id;
    ELSE
        INSERT INTO public.group_members (id, group_id, user_id, display_name, role, joined_at, row_version)
        VALUES (
            gen_random_uuid(),
            v_invite.group_id,
            v_user,
            COALESCE(NULLIF(btrim(p_display_name), ''), (SELECT display_name FROM public.profiles WHERE id = v_user)),
            v_role,
            NOW(),
            v_version
        );
    END IF;

    RETURN v_invite.group_id;
END;
$$;

ALTER FUNCTION "public"."join_group"("p_token" "text", "p_claim_member_id" "uuid", "p_display_name" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."join_with_code"("p_code" "text", "p_claim_member_id" "uuid" DEFAULT NULL::"uuid", "p_display_name" "text" DEFAULT NULL::"text", "p_personal_code" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_role TEXT := CASE WHEN private.is_anonymous() THEN 'guest' ELSE 'member' END;
    v_group public.groups;
    v_mine public.group_members;
    v_target public.group_members;
    v_name TEXT;
    v_member_id UUID;
    v_version BIGINT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;

    v_group := private.find_group_by_code(p_code);
    PERFORM 1 FROM public.groups WHERE id = v_group.id FOR NO KEY UPDATE;
    -- Again, now that the group is locked: it may have been recoded or completed meanwhile.
    v_group := private.find_group_by_code(p_code);

    SELECT * INTO v_mine FROM public.group_members WHERE group_id = v_group.id AND user_id = v_user;
    IF v_mine.id IS NOT NULL AND v_mine.deleted_at IS NULL THEN
        RETURN v_group.id;
    END IF;

    IF p_personal_code IS NOT NULL THEN
        SELECT * INTO v_target FROM public.group_members WHERE id = p_claim_member_id AND group_id = v_group.id;
        IF v_target.id IS NULL OR v_target.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
        END IF;
        IF v_target.user_id IS NOT NULL AND v_target.role <> 'guest' THEN
            RAISE EXCEPTION 'Sign in with your email to get back in' USING ERRCODE = 'HS422';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.guest_codes
            WHERE member_id = v_target.id AND deleted_at IS NULL AND code = private.normalise_code(p_personal_code)
        ) THEN
            RAISE EXCEPTION 'That code doesn''t match' USING ERRCODE = 'HS422';
        END IF;

        v_version := private.next_group_version(v_group.id);
        -- The caller's own old row (they left before) lets go of their login, which can be in a group once.
        IF v_mine.id IS NOT NULL THEN
            UPDATE public.group_members SET user_id = NULL, joined_at = NULL, updated_at = NOW(), row_version = v_version
            WHERE id = v_mine.id;
        END IF;
        IF v_target.user_id IS NOT NULL THEN
            INSERT INTO public.guest_handoffs (group_id, member_id, from_user_id)
            VALUES (v_group.id, v_target.id, v_target.user_id);
        END IF;
        -- A login with an email comes back as a member, and the trigger drops the personal code.
        UPDATE public.group_members
        SET user_id = v_user, role = v_role, joined_at = COALESCE(joined_at, NOW()), updated_at = NOW(),
            row_version = v_version
        WHERE id = v_target.id;
        RETURN v_group.id;
    END IF;

    IF v_mine.id IS NULL AND p_claim_member_id IS NOT NULL THEN
        SELECT * INTO v_target FROM public.group_members WHERE id = p_claim_member_id AND group_id = v_group.id;
        IF v_target.id IS NULL OR v_target.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
        END IF;
        IF v_target.user_id IS NOT NULL THEN
            RAISE EXCEPTION 'Someone has already joined as that person' USING ERRCODE = 'HS422';
        END IF;
    ELSIF v_mine.id IS NULL THEN
        v_name := COALESCE(NULLIF(btrim(p_display_name), ''), (SELECT display_name FROM public.profiles WHERE id = v_user));
        PERFORM private.require_unique_name(v_group.id, v_name, NULL);
    END IF;

    v_version := private.next_group_version(v_group.id);

    IF v_mine.id IS NOT NULL THEN
        v_member_id := v_mine.id;
        UPDATE public.group_members
        SET deleted_at = NULL, role = v_role, joined_at = NOW(), updated_at = NOW(), row_version = v_version
        WHERE id = v_member_id;
    ELSIF v_target.id IS NOT NULL THEN
        v_member_id := v_target.id;
        UPDATE public.group_members
        SET user_id = v_user, role = v_role, joined_at = NOW(), updated_at = NOW(), row_version = v_version
        WHERE id = v_member_id;
    ELSE
        v_member_id := gen_random_uuid();
        INSERT INTO public.group_members (id, group_id, user_id, display_name, role, joined_at, row_version)
        VALUES (v_member_id, v_group.id, v_user, v_name, v_role, NOW(), v_version);
    END IF;

    IF v_role = 'guest' THEN
        PERFORM private.give_guest_code(v_group.id, v_member_id, v_version);
    END IF;

    RETURN v_group.id;
END;
$$;

ALTER FUNCTION "public"."join_with_code"("p_code" "text", "p_claim_member_id" "uuid", "p_display_name" "text", "p_personal_code" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."list_api_tokens"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
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

ALTER FUNCTION "public"."list_api_tokens"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."preview_code"("p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_normal TEXT := private.normalise_code(p_code);
    v_code public.guest_codes;
    v_member public.group_members;
BEGIN
    IF length(v_normal) = 6 THEN
        RETURN jsonb_build_object('kind', 'group') || public.preview_group(v_normal);
    END IF;
    IF length(v_normal) <> 8 THEN
        RAISE EXCEPTION 'This code doesn''t work' USING ERRCODE = 'HS404';
    END IF;

    v_code := private.find_personal_code(v_normal);
    SELECT * INTO v_member FROM public.group_members WHERE id = v_code.member_id;
    IF v_member.role <> 'guest' THEN
        RAISE EXCEPTION 'This code doesn''t work' USING ERRCODE = 'HS404';
    END IF;

    RETURN jsonb_build_object(
        'kind', 'personal',
        'groupId', v_code.group_id,
        'groupName', (SELECT name FROM public.groups WHERE id = v_code.group_id),
        'displayName', v_member.display_name,
        'alreadyMember', EXISTS (
            SELECT 1 FROM public.group_members gm
            WHERE gm.group_id = v_code.group_id AND gm.user_id = (SELECT auth.uid()) AND gm.deleted_at IS NULL
        )
    );
END;
$$;

ALTER FUNCTION "public"."preview_code"("p_code" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."preview_group"("p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_group public.groups := private.find_group_by_code(p_code);
BEGIN
    RETURN jsonb_build_object(
        'groupId', v_group.id,
        'groupName', v_group.name,
        'ownerName', (
            SELECT gm.display_name FROM public.group_members gm
            WHERE gm.group_id = v_group.id AND gm.role = 'owner' AND gm.deleted_at IS NULL
            ORDER BY gm.id LIMIT 1
        ),
        'unclaimed', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('memberId', gm.id, 'displayName', gm.display_name)
                ORDER BY lower(gm.display_name), gm.id)
            FROM public.group_members gm
            WHERE gm.group_id = v_group.id AND gm.user_id IS NULL AND gm.deleted_at IS NULL
        ), '[]'::JSONB),
        'returning', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('memberId', gm.id, 'displayName', gm.display_name)
                ORDER BY lower(gm.display_name), gm.id)
            FROM public.group_members gm
            JOIN public.guest_codes c ON c.member_id = gm.id AND c.deleted_at IS NULL
            WHERE gm.group_id = v_group.id AND gm.role = 'guest' AND gm.user_id IS NOT NULL AND gm.deleted_at IS NULL
        ), '[]'::JSONB),
        'alreadyMember', EXISTS (
            SELECT 1 FROM public.group_members gm
            WHERE gm.group_id = v_group.id AND gm.user_id = (SELECT auth.uid()) AND gm.deleted_at IS NULL
        )
    );
END;
$$;

ALTER FUNCTION "public"."preview_group"("p_code" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."preview_invite"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_invite public.group_invites := private.find_invite(p_token);
BEGIN
    RETURN (
        SELECT jsonb_build_object(
            'groupId', g.id,
            'groupName', g.name,
            'invitedBy', COALESCE(
                (SELECT gm.display_name FROM public.group_members gm WHERE gm.group_id = g.id AND gm.user_id = v_invite.created_by),
                (SELECT p.display_name FROM public.profiles p WHERE p.id = v_invite.created_by)
            ),
            'claimMemberId', (
                SELECT gm.id FROM public.group_members gm
                WHERE gm.id = v_invite.claim_member_id AND gm.user_id IS NULL AND gm.deleted_at IS NULL
            ),
            'unclaimed', COALESCE((
                SELECT jsonb_agg(jsonb_build_object('memberId', gm.id, 'displayName', gm.display_name)
                    ORDER BY lower(gm.display_name), gm.id)
                FROM public.group_members gm
                WHERE gm.group_id = g.id AND gm.user_id IS NULL AND gm.deleted_at IS NULL
            ), '[]'::JSONB),
            'alreadyMember', EXISTS (
                SELECT 1 FROM public.group_members gm
                WHERE gm.group_id = g.id AND gm.user_id = (SELECT auth.uid()) AND gm.deleted_at IS NULL
            )
        )
        FROM public.groups g
        WHERE g.id = v_invite.group_id
    );
END;
$$;

ALTER FUNCTION "public"."preview_invite"("p_token" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_changes"("p_cursors" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    WITH mine AS (
        SELECT g.id, g.head_version, COALESCE((p_cursors->>(g.id::TEXT))::BIGINT, 0) AS since
        FROM public.groups g
        WHERE public.is_group_member(g.id)
    )
    SELECT jsonb_build_object(
        'group_ids', COALESCE((SELECT jsonb_agg(m.id) FROM mine m), '[]'::JSONB),
        'moved_away', COALESCE((
            SELECT jsonb_agg(DISTINCT h.group_id)
            FROM public.guest_handoffs h
            WHERE h.from_user_id = (SELECT auth.uid()) AND NOT EXISTS (SELECT 1 FROM mine m WHERE m.id = h.group_id)
        ), '[]'::JSONB),
        'changes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'group_id', m.id,
                'version', m.head_version,
                'groups', COALESCE((
                    SELECT jsonb_agg(public.pull_group_row(g))
                    FROM public.groups g
                    WHERE g.id = m.id AND g.row_version > m.since
                ), '[]'::JSONB),
                'members', COALESCE((
                    SELECT jsonb_agg(public.pull_member_row(gm))
                    FROM public.group_members gm
                    WHERE gm.group_id = m.id AND gm.row_version > m.since
                ), '[]'::JSONB),
                'entries', COALESCE((
                    SELECT jsonb_agg(public.pull_entry_row(e))
                    FROM public.ledger_entries e
                    WHERE e.group_id = m.id AND e.row_version > m.since
                ), '[]'::JSONB),
                'conflicts', COALESCE((
                    SELECT jsonb_agg(public.pull_conflict_row(c))
                    FROM public.entry_conflicts c
                    WHERE c.group_id = m.id AND c.row_version > m.since
                ), '[]'::JSONB),
                'invites', COALESCE((
                    SELECT jsonb_agg(public.pull_invite_row(
                        i.id, i.group_id, i.claim_member_id, i.created_by, i.created_at, i.expires_at, i.revoked_at, i.row_version
                    ))
                    FROM public.group_invites i
                    WHERE i.group_id = m.id AND i.row_version > m.since
                ), '[]'::JSONB),
                'nudges', COALESCE((
                    SELECT jsonb_agg(public.pull_nudge_row(n))
                    FROM public.nudges n
                    WHERE n.group_id = m.id AND n.row_version > m.since
                ), '[]'::JSONB),
                'guest_codes', COALESCE((
                    SELECT jsonb_agg(public.pull_guest_code_row(gc))
                    FROM public.guest_codes gc
                    WHERE gc.group_id = m.id AND gc.row_version > m.since
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

ALTER FUNCTION "public"."pull_changes"("p_cursors" "jsonb") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."entry_conflicts" (
    "id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "entry_id" "uuid" NOT NULL,
    "base_version" bigint NOT NULL,
    "base" "jsonb",
    "proposed" "jsonb",
    "proposed_by_member_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by_member_id" "uuid",
    "resolution" "text",
    "row_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "entry_conflicts_resolution_check" CHECK (("resolution" = ANY (ARRAY['kept_current'::"text", 'took_proposed'::"text", 'merged'::"text"])))
);

ALTER TABLE "public"."entry_conflicts" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_conflict_row"("c" "public"."entry_conflicts") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', c.id,
        'group_id', c.group_id,
        'entry_id', c.entry_id,
        'base_version', c.base_version,
        'base', c.base,
        'proposed', c.proposed,
        'proposed_by_member_id', c.proposed_by_member_id,
        'created_at', c.created_at,
        'resolved_at', c.resolved_at,
        'resolved_by_member_id', c.resolved_by_member_id,
        'resolution', c.resolution,
        'row_version', c.row_version
    );
$$;

ALTER FUNCTION "public"."pull_conflict_row"("c" "public"."entry_conflicts") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_entry_row"("e" "public"."ledger_entries") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', e.id,
        'group_id', e.group_id,
        'kind', e.kind,
        'description', e.description,
        'amount_cents', e.amount_cents,
        'items', e.items,
        'entry_date', e.entry_date,
        'notes', e.notes,
        'category', e.category,
        'payment_status', e.payment_status,
        'payer_confirmed_at', e.payer_confirmed_at,
        'receiver_confirmed_at', e.receiver_confirmed_at,
        'confirmed_at', e.confirmed_at,
        'closed_at', e.closed_at,
        'close_note', e.close_note,
        'created_by_member_id', e.created_by_member_id,
        'updated_by_member_id', e.updated_by_member_id,
        'created_at', e.created_at,
        'updated_at', e.updated_at,
        'deleted_at', e.deleted_at,
        'row_version', e.row_version,
        'shares', COALESCE((
            SELECT jsonb_agg(public.pull_share_row(s) ORDER BY s.member_id)
            FROM public.ledger_shares s
            WHERE s.entry_id = e.id
        ), '[]'::JSONB)
    );
$$;

ALTER FUNCTION "public"."pull_entry_row"("e" "public"."ledger_entries") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_group_row"("g" "public"."groups") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'note', g.note,
        'cover_color', g.cover_color,
        'cover_sticker', g.cover_sticker,
        'base_currency', g.base_currency,
        'join_code', g.join_code,
        'created_by', g.created_by,
        'created_at', g.created_at,
        'deleted_at', g.deleted_at,
        'completed_at', g.completed_at,
        'completed_by_member_id', g.completed_by_member_id,
        'row_version', g.row_version
    );
$$;

ALTER FUNCTION "public"."pull_group_row"("g" "public"."groups") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_guest_code_row"("gc" "public"."guest_codes") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'member_id', gc.member_id,
        'group_id', gc.group_id,
        'code', gc.code,
        'created_at', gc.created_at,
        'deleted_at', gc.deleted_at,
        'row_version', gc.row_version
    );
$$;

ALTER FUNCTION "public"."pull_guest_code_row"("gc" "public"."guest_codes") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_invite_row"("p_id" "uuid", "p_group_id" "uuid", "p_claim_member_id" "uuid", "p_created_by" "uuid", "p_created_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_revoked_at" timestamp with time zone, "p_row_version" bigint) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', p_id,
        'group_id', p_group_id,
        'claim_member_id', p_claim_member_id,
        'created_by', p_created_by,
        'created_at', p_created_at,
        'expires_at', p_expires_at,
        'revoked_at', p_revoked_at,
        'row_version', p_row_version
    );
$$;

ALTER FUNCTION "public"."pull_invite_row"("p_id" "uuid", "p_group_id" "uuid", "p_claim_member_id" "uuid", "p_created_by" "uuid", "p_created_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_revoked_at" timestamp with time zone, "p_row_version" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_member_row"("gm" "public"."group_members") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', gm.id,
        'group_id', gm.group_id,
        'user_id', gm.user_id,
        'display_name', gm.display_name,
        'role', gm.role,
        'joined_at', gm.joined_at,
        'deleted_at', gm.deleted_at,
        'row_version', gm.row_version
    );
$$;

ALTER FUNCTION "public"."pull_member_row"("gm" "public"."group_members") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."nudges" (
    "id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "from_member_id" "uuid" NOT NULL,
    "to_member_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "row_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "nudges_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "nudges_check" CHECK (("from_member_id" <> "to_member_id"))
);

ALTER TABLE "public"."nudges" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_nudge_row"("n" "public"."nudges") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', n.id,
        'group_id', n.group_id,
        'from_member_id', n.from_member_id,
        'to_member_id', n.to_member_id,
        'amount_cents', n.amount_cents,
        'created_at', n.created_at,
        'row_version', n.row_version
    );
$$;

ALTER FUNCTION "public"."pull_nudge_row"("n" "public"."nudges") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."ledger_shares" (
    "entry_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "paid_cents" bigint NOT NULL,
    "owed_cents" bigint NOT NULL,
    CONSTRAINT "ledger_shares_owed_cents_check" CHECK (("owed_cents" >= 0)),
    CONSTRAINT "ledger_shares_paid_cents_check" CHECK (("paid_cents" >= 0))
);

ALTER TABLE "public"."ledger_shares" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."pull_share_row"("s" "public"."ledger_shares") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
    SELECT jsonb_build_object(
        'member_id', s.member_id,
        'paid_cents', s.paid_cents,
        'owed_cents', s.owed_cents,
        'owed_to', COALESCE((
            SELECT jsonb_object_agg(p.payer_member_id, p.owed_cents)
            FROM public.ledger_share_parts p
            WHERE p.entry_id = s.entry_id AND p.member_id = s.member_id
        ), '{}'::JSONB)
    );
$$;

ALTER FUNCTION "public"."pull_share_row"("s" "public"."ledger_shares") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."push_changes"("p_mutations" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_mutation JSONB;
    v_applied JSONB := '[]'::JSONB;
    v_rejected JSONB := '[]'::JSONB;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;

    FOR v_mutation IN SELECT value FROM jsonb_array_elements(p_mutations) LOOP
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM public.sync_mutations WHERE id = (v_mutation->>'id')::UUID) THEN
                PERFORM private.apply_mutation(v_user, v_mutation);
                INSERT INTO public.sync_mutations (id, user_id) VALUES ((v_mutation->>'id')::UUID, v_user);
            END IF;
            v_applied := v_applied || jsonb_build_array(v_mutation->>'id');
        EXCEPTION WHEN OTHERS THEN
            v_rejected := v_rejected || jsonb_build_array(jsonb_build_object(
                'id', v_mutation->>'id',
                'code', SQLSTATE,
                'reason', SQLERRM
            ));
        END;
    END LOOP;

    RETURN jsonb_build_object('applied', v_applied, 'rejected', v_rejected);
END;
$$;

ALTER FUNCTION "public"."push_changes"("p_mutations" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."return_with_code"("p_code" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_role TEXT := CASE WHEN private.is_anonymous() THEN 'guest' ELSE 'member' END;
    v_code public.guest_codes;
    v_mine public.group_members;
    v_target public.group_members;
    v_version BIGINT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;

    v_code := private.find_personal_code(p_code);
    PERFORM 1 FROM public.groups WHERE id = v_code.group_id FOR NO KEY UPDATE;
    -- Again, now that the group is locked: it may have been completed, or the name taken, meanwhile.
    v_code := private.find_personal_code(p_code);

    SELECT * INTO v_target FROM public.group_members WHERE id = v_code.member_id;
    IF v_target.role <> 'guest' THEN
        RAISE EXCEPTION 'Sign in with your email to get back in' USING ERRCODE = 'HS422';
    END IF;

    SELECT * INTO v_mine FROM public.group_members WHERE group_id = v_code.group_id AND user_id = v_user;
    IF v_mine.id IS NOT NULL AND v_mine.deleted_at IS NULL THEN
        RETURN v_code.group_id;
    END IF;

    v_version := private.next_group_version(v_code.group_id);
    IF v_mine.id IS NOT NULL THEN
        UPDATE public.group_members SET user_id = NULL, joined_at = NULL, updated_at = NOW(), row_version = v_version
        WHERE id = v_mine.id;
    END IF;
    INSERT INTO public.guest_handoffs (group_id, member_id, from_user_id)
    VALUES (v_code.group_id, v_target.id, v_target.user_id);
    UPDATE public.group_members
    SET user_id = v_user, role = v_role, joined_at = COALESCE(joined_at, NOW()), updated_at = NOW(),
        row_version = v_version
    WHERE id = v_target.id;
    RETURN v_code.group_id;
END;
$$;

ALTER FUNCTION "public"."return_with_code"("p_code" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."revoke_api_token"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := private.require_account();
BEGIN
    UPDATE public.api_tokens SET revoked_at = NOW() WHERE id = p_id AND user_id = v_user AND revoked_at IS NULL;
END;
$$;

ALTER FUNCTION "public"."revoke_api_token"("p_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."upgrade_guest"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_group_id UUID;
    v_version BIGINT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;
    IF private.is_anonymous() OR NOT EXISTS (
        SELECT 1 FROM auth.users WHERE id = v_user AND NOT is_anonymous AND email IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Add an email to your account first' USING ERRCODE = 'HS403';
    END IF;

    UPDATE public.profiles SET email = (SELECT email FROM auth.users WHERE id = v_user) WHERE id = v_user;

    FOR v_group_id IN
        SELECT DISTINCT group_id FROM public.group_members WHERE user_id = v_user AND role = 'guest' ORDER BY group_id
    LOOP
        v_version := private.next_group_version(v_group_id);
        UPDATE public.group_members
        SET role = 'member', updated_at = NOW(), row_version = v_version
        WHERE group_id = v_group_id AND user_id = v_user AND role = 'guest';
    END LOOP;
END;
$$;

ALTER FUNCTION "public"."upgrade_guest"() OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."api_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "scope" "text" DEFAULT 'read'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "rate_window_start" timestamp with time zone,
    "rate_window_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "api_tokens_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 60))),
    CONSTRAINT "api_tokens_scope_check" CHECK (("scope" = 'read'::"text"))
);

ALTER TABLE "public"."api_tokens" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."guest_handoffs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "moved_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."guest_handoffs" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."ledger_entry_versions" (
    "entry_id" "uuid" NOT NULL,
    "row_version" bigint NOT NULL,
    "snapshot" "jsonb" NOT NULL
);

ALTER TABLE "public"."ledger_entry_versions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."ledger_share_parts" (
    "entry_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "payer_member_id" "uuid" NOT NULL,
    "owed_cents" bigint NOT NULL,
    CONSTRAINT "ledger_share_parts_owed_cents_check" CHECK (("owed_cents" > 0))
);

ALTER TABLE "public"."ledger_share_parts" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_display_name_check" CHECK ((("char_length"("btrim"("display_name")) >= 1) AND ("char_length"("btrim"("display_name")) <= 60)))
);

ALTER TABLE "public"."profiles" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."sync_mutations" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."sync_mutations" OWNER TO "postgres";

ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "public"."entry_conflicts"
    ADD CONSTRAINT "entry_conflicts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."group_invites"
    ADD CONSTRAINT "group_invites_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."group_invites"
    ADD CONSTRAINT "group_invites_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."groups"
    ADD CONSTRAINT "groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."guest_codes"
    ADD CONSTRAINT "guest_codes_pkey" PRIMARY KEY ("member_id");

ALTER TABLE ONLY "public"."guest_handoffs"
    ADD CONSTRAINT "guest_handoffs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."ledger_entry_versions"
    ADD CONSTRAINT "ledger_entry_versions_pkey" PRIMARY KEY ("entry_id", "row_version");

ALTER TABLE ONLY "public"."ledger_share_parts"
    ADD CONSTRAINT "ledger_share_parts_pkey" PRIMARY KEY ("entry_id", "member_id", "payer_member_id");

ALTER TABLE ONLY "public"."ledger_shares"
    ADD CONSTRAINT "ledger_shares_pkey" PRIMARY KEY ("entry_id", "member_id");

ALTER TABLE ONLY "public"."nudges"
    ADD CONSTRAINT "nudges_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."sync_mutations"
    ADD CONSTRAINT "sync_mutations_pkey" PRIMARY KEY ("id");

CREATE INDEX "api_tokens_user_idx" ON "public"."api_tokens" USING "btree" ("user_id") WHERE ("revoked_at" IS NULL);

CREATE INDEX "entry_conflicts_open_idx" ON "public"."entry_conflicts" USING "btree" ("entry_id") WHERE ("resolved_at" IS NULL);

CREATE INDEX "entry_conflicts_version_idx" ON "public"."entry_conflicts" USING "btree" ("group_id", "row_version");

CREATE INDEX "group_invites_version_idx" ON "public"."group_invites" USING "btree" ("group_id", "row_version");

CREATE UNIQUE INDEX "group_members_group_id_idx" ON "public"."group_members" USING "btree" ("group_id", "id");

CREATE UNIQUE INDEX "group_members_group_user_idx" ON "public"."group_members" USING "btree" ("group_id", "user_id") WHERE ("user_id" IS NOT NULL);

CREATE INDEX "group_members_user_idx" ON "public"."group_members" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "group_members_version_idx" ON "public"."group_members" USING "btree" ("group_id", "row_version");

CREATE UNIQUE INDEX "groups_join_code_idx" ON "public"."groups" USING "btree" ("join_code");

CREATE UNIQUE INDEX "guest_codes_live_code_idx" ON "public"."guest_codes" USING "btree" ("code") WHERE ("deleted_at" IS NULL);

CREATE INDEX "guest_codes_version_idx" ON "public"."guest_codes" USING "btree" ("group_id", "row_version");

CREATE INDEX "guest_handoffs_user_idx" ON "public"."guest_handoffs" USING "btree" ("from_user_id");

CREATE INDEX "ledger_entries_date_idx" ON "public"."ledger_entries" USING "btree" ("group_id", "entry_date");

CREATE INDEX "ledger_entries_pending_idx" ON "public"."ledger_entries" USING "btree" ("group_id") WHERE ("payment_status" = 'pending'::"text");

CREATE INDEX "ledger_entries_version_idx" ON "public"."ledger_entries" USING "btree" ("group_id", "row_version");

CREATE INDEX "ledger_share_parts_payer_idx" ON "public"."ledger_share_parts" USING "btree" ("payer_member_id");

CREATE INDEX "ledger_shares_member_idx" ON "public"."ledger_shares" USING "btree" ("member_id");

CREATE INDEX "nudges_pair_idx" ON "public"."nudges" USING "btree" ("from_member_id", "to_member_id", "created_at");

CREATE INDEX "nudges_version_idx" ON "public"."nudges" USING "btree" ("group_id", "row_version");

CREATE OR REPLACE TRIGGER "group_members_drop_guest_code" AFTER UPDATE OF "user_id", "role" ON "public"."group_members" FOR EACH ROW WHEN ((("new"."role" <> 'guest'::"text") OR ("new"."user_id" IS NULL))) EXECUTE FUNCTION "private"."drop_guest_code"();

CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();

ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."entry_conflicts"
    ADD CONSTRAINT "entry_conflicts_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."entry_conflicts"
    ADD CONSTRAINT "entry_conflicts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."entry_conflicts"
    ADD CONSTRAINT "entry_conflicts_proposed_by_member_id_fkey" FOREIGN KEY ("proposed_by_member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."entry_conflicts"
    ADD CONSTRAINT "entry_conflicts_resolved_by_member_id_fkey" FOREIGN KEY ("resolved_by_member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."group_invites"
    ADD CONSTRAINT "group_invites_claim_member_id_fkey" FOREIGN KEY ("claim_member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."group_invites"
    ADD CONSTRAINT "group_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."group_invites"
    ADD CONSTRAINT "group_invites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."groups"
    ADD CONSTRAINT "groups_completed_by_member_id_fkey" FOREIGN KEY ("completed_by_member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."groups"
    ADD CONSTRAINT "groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."guest_codes"
    ADD CONSTRAINT "guest_codes_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."guest_codes"
    ADD CONSTRAINT "guest_codes_group_id_member_id_fkey" FOREIGN KEY ("group_id", "member_id") REFERENCES "public"."group_members"("group_id", "id");

ALTER TABLE ONLY "public"."guest_handoffs"
    ADD CONSTRAINT "guest_handoffs_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."guest_handoffs"
    ADD CONSTRAINT "guest_handoffs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."guest_handoffs"
    ADD CONSTRAINT "guest_handoffs_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_created_by_member_id_fkey" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_updated_by_member_id_fkey" FOREIGN KEY ("updated_by_member_id") REFERENCES "public"."group_members"("id");

ALTER TABLE ONLY "public"."ledger_entry_versions"
    ADD CONSTRAINT "ledger_entry_versions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_share_parts"
    ADD CONSTRAINT "ledger_share_parts_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_share_parts"
    ADD CONSTRAINT "ledger_share_parts_entry_id_member_id_fkey" FOREIGN KEY ("entry_id", "member_id") REFERENCES "public"."ledger_shares"("entry_id", "member_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_share_parts"
    ADD CONSTRAINT "ledger_share_parts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_share_parts"
    ADD CONSTRAINT "ledger_share_parts_group_id_payer_member_id_fkey" FOREIGN KEY ("group_id", "payer_member_id") REFERENCES "public"."group_members"("group_id", "id");

ALTER TABLE ONLY "public"."ledger_shares"
    ADD CONSTRAINT "ledger_shares_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_shares"
    ADD CONSTRAINT "ledger_shares_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ledger_shares"
    ADD CONSTRAINT "ledger_shares_group_id_member_id_fkey" FOREIGN KEY ("group_id", "member_id") REFERENCES "public"."group_members"("group_id", "id");

ALTER TABLE ONLY "public"."nudges"
    ADD CONSTRAINT "nudges_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."nudges"
    ADD CONSTRAINT "nudges_group_id_from_member_id_fkey" FOREIGN KEY ("group_id", "from_member_id") REFERENCES "public"."group_members"("group_id", "id");

ALTER TABLE ONLY "public"."nudges"
    ADD CONSTRAINT "nudges_group_id_to_member_id_fkey" FOREIGN KEY ("group_id", "to_member_id") REFERENCES "public"."group_members"("group_id", "id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."sync_mutations"
    ADD CONSTRAINT "sync_mutations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

CREATE POLICY "Members can view their group's conflicts" ON "public"."entry_conflicts" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their group's entries" ON "public"."ledger_entries" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their group's invites" ON "public"."group_invites" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their group's members" ON "public"."group_members" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their group's nudges" ON "public"."nudges" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their group's share parts" ON "public"."ledger_share_parts" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their group's shares" ON "public"."ledger_shares" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("group_id"));

CREATE POLICY "Members can view their groups" ON "public"."groups" FOR SELECT TO "authenticated" USING ("public"."is_group_member"("id"));

CREATE POLICY "Owners and the guest can view a guest code" ON "public"."guest_codes" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "guest_codes"."group_id") AND ("gm"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("gm"."deleted_at" IS NULL) AND (("gm"."role" = 'owner'::"text") OR ("gm"."id" = "guest_codes"."member_id"))))));

CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));

CREATE POLICY "Users can view handoffs away from them" ON "public"."guest_handoffs" FOR SELECT TO "authenticated" USING (("from_user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));

ALTER TABLE "public"."api_tokens" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."entry_conflicts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."group_invites" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."group_members" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."groups" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."guest_codes" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."guest_handoffs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."ledger_entries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."ledger_entry_versions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."ledger_share_parts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."ledger_shares" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."nudges" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."sync_mutations" ENABLE ROW LEVEL SECURITY;

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

GRANT USAGE ON SCHEMA "api" TO "handshake_api";

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

REVOKE ALL ON FUNCTION "api"."v1_group"("p_token_hash" "text", "p_group_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "api"."v1_group"("p_token_hash" "text", "p_group_id" "uuid") TO "handshake_api";

REVOKE ALL ON FUNCTION "api"."v1_groups"("p_token_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "api"."v1_groups"("p_token_hash" "text") TO "handshake_api";

REVOKE ALL ON FUNCTION "api"."v1_me"("p_token_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "api"."v1_me"("p_token_hash" "text") TO "handshake_api";

REVOKE ALL ON FUNCTION "api"."v1_payments"("p_token_hash" "text", "p_group_id" "uuid", "p_cursor" "jsonb", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "api"."v1_payments"("p_token_hash" "text", "p_group_id" "uuid", "p_cursor" "jsonb", "p_limit" integer) TO "handshake_api";

REVOKE ALL ON FUNCTION "private"."allowed_when_completed"("p_action" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."answer_payment"("p_user" "uuid", "p_mutation" "jsonb", "p_confirm" boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."api_authenticate"("p_token_hash" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."new_join_code"() FROM PUBLIC;

GRANT ALL ON TABLE "public"."group_members" TO "service_role";
GRANT SELECT ON TABLE "public"."group_members" TO "authenticated";

GRANT ALL ON TABLE "public"."groups" TO "service_role";
GRANT SELECT ON TABLE "public"."groups" TO "authenticated";

REVOKE ALL ON FUNCTION "private"."api_group"("p_group" "public"."groups", "p_member" "public"."group_members") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_conflict_resolve"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_entry_create"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_entry_delete"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_entry_update"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_complete"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_create"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_delete"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_describe"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_recode"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_recolor"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_rename"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_reopen"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_group_sticker"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_invite_create"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_invite_revoke"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_member_add"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_member_remove"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_member_rename"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_mutation"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_nudge_send"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_payment_confirm"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_payment_decline"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_payment_record"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."apply_payment_undo"("p_user" "uuid", "p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."bill_description"("p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."bill_items"("p_items" "jsonb", "p_amount" numeric) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."bill_people_in_group"("p_group_id" "uuid", "p_shares" "jsonb", "p_items" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."bill_shares"("p_shares" "jsonb", "p_amount" numeric) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."bill_shares_match_items"("p_shares" "jsonb", "p_items" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."caller_member"("p_user" "uuid", "p_group_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."can_answer"("p_member" "public"."group_members") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."compute_shares"("p_items" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."cover_color"("p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."cover_sticker"("p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."debt_between"("p_group_id" "uuid", "p_from" "uuid", "p_to" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."delete_entry"("p_entry_id" "uuid", "p_member_id" "uuid", "p_version" bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."drop_guest_code"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_amount"("p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_category"("p_entry" "jsonb") FROM PUBLIC;

GRANT ALL ON TABLE "public"."ledger_entries" TO "service_role";
GRANT SELECT ON TABLE "public"."ledger_entries" TO "authenticated";

REVOKE ALL ON FUNCTION "private"."entry_counts"("p_entry" "public"."ledger_entries") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_date"("p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_description"("p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_notes"("p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_proposal"("p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."entry_snapshot"("p_entry_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."find_group_by_code"("p_code" "text") FROM PUBLIC;

GRANT ALL ON TABLE "public"."group_invites" TO "service_role";

GRANT SELECT("id") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("group_id") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("claim_member_id") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("created_by") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("created_at") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("expires_at") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("revoked_at") ON TABLE "public"."group_invites" TO "authenticated";

GRANT SELECT("row_version") ON TABLE "public"."group_invites" TO "authenticated";

REVOKE ALL ON FUNCTION "private"."find_invite"("p_token" "text") FROM PUBLIC;

GRANT ALL ON TABLE "public"."guest_codes" TO "service_role";
GRANT SELECT ON TABLE "public"."guest_codes" TO "authenticated";

REVOKE ALL ON FUNCTION "private"."find_personal_code"("p_code" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."give_guest_code"("p_group_id" "uuid", "p_member_id" "uuid", "p_version" bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."group_note"("p_mutation" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."hand_over"("p_group_id" "uuid", "p_version" bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."handle_new_user"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."hash_token"("p_token" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."is_anonymous"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."is_cents"("p_value" "jsonb", "p_min" numeric) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."is_stale"("p_mutation" "jsonb", "p_entry" "public"."ledger_entries", "p_member_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."may"("p_action" "text", "p_role" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."may_record_payment"("p_recorder_id" "uuid", "p_from" "public"."group_members", "p_to" "public"."group_members") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."new_personal_code"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."next_group_version"("p_group_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."no_payment_waiting"("p_group_id" "uuid", "p_a" "uuid", "p_b" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."normalise_code"("p_code" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."open_conflict"("p_mutation" "jsonb", "p_entry" "public"."ledger_entries", "p_member_id" "uuid", "p_version" bigint, "p_proposed" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."payment_answerer"("p_recorder_id" "uuid", "p_from" "public"."group_members", "p_to" "public"."group_members") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."payment_sides"("p_entry_id" "uuid", OUT "from_member_id" "uuid", OUT "to_member_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."payment_sides"("p_group_id" "uuid", "p_mutation" "jsonb", OUT "from_member" "public"."group_members", OUT "to_member" "public"."group_members") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."pending_payment"("p_group_id" "uuid", "p_entry_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."random_code"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."random_code"("p_length" integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."record_entry_version"("p_entry_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."renew_short_guest_codes"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."require"("p_user" "uuid", "p_group_id" "uuid", "p_action" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."require_account"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."require_name"("p_name" "text", "p_max" integer, "p_what" "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."require_unique_name"("p_group_id" "uuid", "p_name" "text", "p_except" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."save_entry"("p_entry_id" "uuid", "p_group_id" "uuid", "p_entry" "jsonb", "p_member_id" "uuid", "p_version" bigint, "p_is_new" boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."share_rows"("p_shares" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."stored_bill"("p_group_id" "uuid", "p_entry_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."undo_pending_payments"("p_member_id" "uuid", "p_version" bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."validate_entry"("p_group_id" "uuid", "p_entry" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "private"."write_shares"("p_entry_id" "uuid", "p_group_id" "uuid", "p_shares" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."create_api_token"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_api_token"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_api_token"("p_name" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."delete_account"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_account"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_account"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."is_group_member"("p_group_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_group_member"("p_group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_group_member"("p_group_id" "uuid") TO "service_role";

REVOKE ALL ON FUNCTION "public"."join_group"("p_token" "text", "p_claim_member_id" "uuid", "p_display_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_group"("p_token" "text", "p_claim_member_id" "uuid", "p_display_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_group"("p_token" "text", "p_claim_member_id" "uuid", "p_display_name" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."join_with_code"("p_code" "text", "p_claim_member_id" "uuid", "p_display_name" "text", "p_personal_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_with_code"("p_code" "text", "p_claim_member_id" "uuid", "p_display_name" "text", "p_personal_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_with_code"("p_code" "text", "p_claim_member_id" "uuid", "p_display_name" "text", "p_personal_code" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."list_api_tokens"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_api_tokens"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_api_tokens"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."preview_code"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preview_code"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."preview_code"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_code"("p_code" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."preview_group"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preview_group"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."preview_group"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_group"("p_code" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."preview_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preview_invite"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."preview_invite"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_invite"("p_token" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."pull_changes"("p_cursors" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_changes"("p_cursors" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_changes"("p_cursors" "jsonb") TO "service_role";

GRANT ALL ON TABLE "public"."entry_conflicts" TO "service_role";
GRANT SELECT ON TABLE "public"."entry_conflicts" TO "authenticated";

REVOKE ALL ON FUNCTION "public"."pull_conflict_row"("c" "public"."entry_conflicts") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_conflict_row"("c" "public"."entry_conflicts") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_conflict_row"("c" "public"."entry_conflicts") TO "service_role";

REVOKE ALL ON FUNCTION "public"."pull_entry_row"("e" "public"."ledger_entries") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_entry_row"("e" "public"."ledger_entries") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_entry_row"("e" "public"."ledger_entries") TO "service_role";

REVOKE ALL ON FUNCTION "public"."pull_group_row"("g" "public"."groups") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_group_row"("g" "public"."groups") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_group_row"("g" "public"."groups") TO "service_role";

REVOKE ALL ON FUNCTION "public"."pull_guest_code_row"("gc" "public"."guest_codes") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_guest_code_row"("gc" "public"."guest_codes") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_guest_code_row"("gc" "public"."guest_codes") TO "service_role";

REVOKE ALL ON FUNCTION "public"."pull_invite_row"("p_id" "uuid", "p_group_id" "uuid", "p_claim_member_id" "uuid", "p_created_by" "uuid", "p_created_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_revoked_at" timestamp with time zone, "p_row_version" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_invite_row"("p_id" "uuid", "p_group_id" "uuid", "p_claim_member_id" "uuid", "p_created_by" "uuid", "p_created_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_revoked_at" timestamp with time zone, "p_row_version" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_invite_row"("p_id" "uuid", "p_group_id" "uuid", "p_claim_member_id" "uuid", "p_created_by" "uuid", "p_created_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_revoked_at" timestamp with time zone, "p_row_version" bigint) TO "service_role";

REVOKE ALL ON FUNCTION "public"."pull_member_row"("gm" "public"."group_members") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_member_row"("gm" "public"."group_members") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_member_row"("gm" "public"."group_members") TO "service_role";

GRANT ALL ON TABLE "public"."nudges" TO "service_role";
GRANT SELECT ON TABLE "public"."nudges" TO "authenticated";

REVOKE ALL ON FUNCTION "public"."pull_nudge_row"("n" "public"."nudges") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_nudge_row"("n" "public"."nudges") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_nudge_row"("n" "public"."nudges") TO "service_role";

GRANT ALL ON TABLE "public"."ledger_shares" TO "service_role";
GRANT SELECT ON TABLE "public"."ledger_shares" TO "authenticated";

REVOKE ALL ON FUNCTION "public"."pull_share_row"("s" "public"."ledger_shares") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pull_share_row"("s" "public"."ledger_shares") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pull_share_row"("s" "public"."ledger_shares") TO "service_role";

REVOKE ALL ON FUNCTION "public"."push_changes"("p_mutations" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."push_changes"("p_mutations" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."push_changes"("p_mutations" "jsonb") TO "service_role";

REVOKE ALL ON FUNCTION "public"."return_with_code"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."return_with_code"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."return_with_code"("p_code" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."revoke_api_token"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_api_token"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_api_token"("p_id" "uuid") TO "service_role";

REVOKE ALL ON FUNCTION "public"."update_updated_at_column"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."upgrade_guest"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upgrade_guest"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."upgrade_guest"() TO "service_role";

GRANT ALL ON TABLE "public"."api_tokens" TO "service_role";

GRANT ALL ON TABLE "public"."guest_handoffs" TO "service_role";
GRANT SELECT ON TABLE "public"."guest_handoffs" TO "authenticated";

GRANT ALL ON TABLE "public"."ledger_entry_versions" TO "service_role";

GRANT ALL ON TABLE "public"."ledger_share_parts" TO "service_role";
GRANT SELECT ON TABLE "public"."ledger_share_parts" TO "authenticated";

GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";

GRANT UPDATE("display_name") ON TABLE "public"."profiles" TO "authenticated";

GRANT ALL ON TABLE "public"."sync_mutations" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "private"."handle_new_user"();

-- New functions in private and api are not executable by anyone unless granted (dumps leave this out).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
