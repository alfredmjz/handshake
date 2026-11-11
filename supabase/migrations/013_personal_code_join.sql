-- Migration: 013_personal_code_join
-- Description: A guest gets back into their group with their personal code alone (owner decisions of
-- 2026-11-11). Personal codes become 8 characters from the same alphabet, unique across all groups and never
-- equal to a group code; existing ones are replaced, each group's in a new version so devices pull them.
-- preview_code() tells what a code is (a group code or a personal code); return_with_code() takes the guest's
-- name back as join_with_code's come-back path does. preview_group and join_with_code stay as they are.

-- =============================================================================
-- 8-character personal codes
-- =============================================================================

-- As private.random_code() (012), any length.
CREATE OR REPLACE FUNCTION private.random_code(p_length INT)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SET search_path = ''
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

-- Unused by any live personal code in any group, and never a group code (lengths differ; checked anyway).
CREATE OR REPLACE FUNCTION private.new_personal_code()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SET search_path = ''
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

-- As in 012, with an 8-character code unique across groups.
CREATE OR REPLACE FUNCTION private.give_guest_code(p_group_id UUID, p_member_id UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

ALTER TABLE public.guest_codes DROP CONSTRAINT IF EXISTS guest_codes_code_check;
DROP INDEX IF EXISTS public.guest_codes_code_idx;

-- Replaces every code that isn't 8 characters yet (so a re-run changes nothing), one new version per group.
-- Deleted rows are replaced too, so the table's check holds for every row.
CREATE OR REPLACE FUNCTION private.renew_short_guest_codes()
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

SELECT private.renew_short_guest_codes();

ALTER TABLE public.guest_codes ADD CONSTRAINT guest_codes_code_check CHECK (code ~ '^[A-HJKMNP-Z2-9]{8}$');
CREATE UNIQUE INDEX IF NOT EXISTS guest_codes_live_code_idx ON public.guest_codes (code) WHERE deleted_at IS NULL;

-- =============================================================================
-- Getting back in with a personal code alone (online only)
-- =============================================================================

-- The live personal code p_code (any case, dash ignored), in a group that is neither deleted nor completed,
-- of someone still in it with a login. HS404 otherwise.
CREATE OR REPLACE FUNCTION private.find_personal_code(p_code TEXT)
RETURNS public.guest_codes
LANGUAGE plpgsql STABLE SET search_path = ''
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

-- What a typed code is, signed out too. 6 characters: { "kind": "group" } and preview_group's fields.
-- 8 characters: { "kind": "personal", "groupId", "groupName", "displayName", "alreadyMember" }, the guest
-- whose code it is. HS404 "This code doesn't work" for anything else, or when the code doesn't open anything.
CREATE OR REPLACE FUNCTION public.preview_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
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

-- Takes back the name whose personal code p_code is and returns the group id; nothing changes if the caller
-- is already in the group. As join_with_code's come-back path: the row moves to the caller's login (guest if
-- anonymous, else member, which drops the code), a guest_handoffs row records the login it left, and the
-- caller's own old left row lets go of their login.
CREATE OR REPLACE FUNCTION public.return_with_code(p_code TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.preview_code(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.return_with_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_code(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.return_with_code(TEXT) TO authenticated;
