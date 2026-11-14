-- ============================================================================
-- Migration 019: names are refused with HS422, not by the tables' CHECKs (23514)
--
-- Group names are 1 to 80 characters and people's names 1 to 60, after trimming. The CHECKs on groups.name
-- and group_members.display_name still hold; private.require_name() now refuses first, with the HS422 the
-- device plans (src/lib/changes.ts), at the same point in each function as planChange checks it.
--
-- group.create: a blank owner's name is refused too. The profile name is used only when no displayName is
-- sent at all.
-- ============================================================================

CREATE OR REPLACE FUNCTION private.require_name(p_name TEXT, p_max INTEGER, p_what TEXT)
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND p_max THEN
        RAISE EXCEPTION '% must be 1 to % characters', p_what, p_max USING ERRCODE = 'HS422';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_group_create(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

CREATE OR REPLACE FUNCTION private.apply_group_rename(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

CREATE OR REPLACE FUNCTION private.apply_member_add(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

CREATE OR REPLACE FUNCTION private.apply_member_rename(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

REVOKE EXECUTE ON FUNCTION private.require_name(TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
