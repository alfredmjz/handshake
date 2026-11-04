-- Migration: 004_people
-- Description: Roles (owner, member, guest), when each person joined, and the people changes:
-- member.add, member.rename, member.remove (which is also how someone leaves) and group.delete.
-- push_changes() now reports an HS code with every rejection, and apply_mutation() hands each change
-- type to its own private.apply_<type> function. There is no admin role: what isn't for everyone is
-- for the owner alone.

ALTER TABLE public.group_members DROP CONSTRAINT IF EXISTS group_members_role_check;
ALTER TABLE public.group_members
    ADD CONSTRAINT group_members_role_check CHECK (role IN ('owner', 'member', 'guest'));

-- Set whenever user_id is set. NULL for someone added by name who hasn't joined yet.
ALTER TABLE public.group_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
UPDATE public.group_members SET joined_at = created_at WHERE user_id IS NOT NULL AND joined_at IS NULL;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- =============================================================================
-- Shared checks
-- =============================================================================

CREATE OR REPLACE FUNCTION private.is_anonymous()
RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT COALESCE((auth.jwt()->>'is_anonymous')::BOOLEAN, FALSE);
$$;

-- The caller's active member row in the group, or NULL.
CREATE OR REPLACE FUNCTION private.caller_member(p_user UUID, p_group_id UUID)
RETURNS public.group_members
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT * FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user AND deleted_at IS NULL;
$$;

-- Locks the group row first, so changes to one group apply one at a time and every check after this
-- sees what the previous change committed. p_allow_completed is for group.reopen and group.delete,
-- the only changes a completed group accepts (008).
CREATE OR REPLACE FUNCTION private.require_member(
    p_user UUID,
    p_group_id UUID,
    p_roles TEXT[],
    p_allow_completed BOOLEAN DEFAULT FALSE
)
RETURNS public.group_members
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_member public.group_members;
BEGIN
    PERFORM 1 FROM public.groups WHERE id = p_group_id FOR NO KEY UPDATE;
    v_member := private.caller_member(p_user, p_group_id);

    IF v_member.id IS NULL THEN
        RAISE EXCEPTION 'You are not a member of this group' USING ERRCODE = 'HS403';
    END IF;
    IF EXISTS (SELECT 1 FROM public.groups WHERE id = p_group_id AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'This group was deleted' USING ERRCODE = 'HS403';
    END IF;
    IF NOT v_member.role = ANY (p_roles) THEN
        RAISE EXCEPTION '%', CASE WHEN p_roles = ARRAY['owner'] THEN 'Only the group''s owner can do this'
            ELSE 'Guests can''t do this' END
            USING ERRCODE = 'HS403';
    END IF;

    RETURN v_member;
END;
$$;

-- =============================================================================
-- Changes
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_group_create(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    IF private.is_anonymous() THEN
        RAISE EXCEPTION 'Guests can''t create groups' USING ERRCODE = 'HS403';
    END IF;

    -- Devices stop sending baseCurrency; the column default applies then.
    IF p_mutation->>'baseCurrency' IS NULL THEN
        INSERT INTO public.groups (id, name, created_by) VALUES (v_group_id, btrim(p_mutation->>'name'), p_user);
    ELSE
        INSERT INTO public.groups (id, name, base_currency, created_by)
        VALUES (v_group_id, btrim(p_mutation->>'name'), upper(p_mutation->>'baseCurrency'), p_user);
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET row_version = v_version WHERE id = v_group_id;

    INSERT INTO public.group_members (id, group_id, user_id, display_name, role, joined_at, row_version)
    VALUES (
        (p_mutation->>'memberId')::UUID,
        v_group_id,
        p_user,
        COALESCE(
            NULLIF(btrim(p_mutation->>'displayName'), ''),
            (SELECT display_name FROM public.profiles WHERE id = p_user)
        ),
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
    PERFORM private.require_member(p_user, v_group_id, ARRAY['owner']);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET name = btrim(p_mutation->>'name'), updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_group_delete(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require_member(p_user, v_group_id, ARRAY['owner'], TRUE);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET deleted_at = NOW(), updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

-- Someone added by name: no user yet, so they can be in bills before they join.
CREATE OR REPLACE FUNCTION private.apply_member_add(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require_member(p_user, v_group_id, ARRAY['owner']);

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
    v_version BIGINT;
BEGIN
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner', 'member', 'guest']);

    IF v_target <> v_me.id AND v_me.role <> 'owner' THEN
        RAISE EXCEPTION 'Only the group''s owner can rename other people' USING ERRCODE = 'HS403';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.group_members WHERE id = v_target AND group_id = v_group_id) THEN
        RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.group_members
    SET display_name = btrim(p_mutation->>'displayName'), updated_at = NOW(), row_version = v_version
    WHERE id = v_target;
END;
$$;

-- Removing yourself is leaving. The member row stays (soft delete), so the person's shares and
-- history stay too.
CREATE OR REPLACE FUNCTION private.apply_member_remove(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_target public.group_members;
    v_version BIGINT;
BEGIN
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner', 'member', 'guest']);

    IF (p_mutation->>'memberId')::UUID <> v_me.id AND v_me.role <> 'owner' THEN
        RAISE EXCEPTION 'Only the group''s owner can remove other people' USING ERRCODE = 'HS403';
    END IF;

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

    -- Only the owner can remove the owner, so this is the owner leaving. Ownership passes to the full
    -- member who joined first; with no full member left the group is deleted, even if guests remain.
    IF v_target.role = 'owner' THEN
        UPDATE public.group_members SET role = 'owner', updated_at = NOW(), row_version = v_version
        WHERE id = (
            SELECT id FROM public.group_members
            WHERE group_id = v_group_id AND role = 'member' AND user_id IS NOT NULL AND deleted_at IS NULL
            ORDER BY joined_at, id
            LIMIT 1
        );

        IF NOT FOUND THEN
            UPDATE public.groups SET deleted_at = NOW(), updated_at = NOW(), row_version = v_version
            WHERE id = v_group_id;
        END IF;
    END IF;
END;
$$;

-- =============================================================================
-- Dispatch and push
-- =============================================================================

-- 'entry.create' runs private.apply_entry_create(p_user, p_mutation). The pattern keeps a type from
-- naming anything but an apply_<area>_<verb> function.
CREATE OR REPLACE FUNCTION private.apply_mutation(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
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
$$;

-- Applies each mutation in order, each in its own savepoint: a bad one is rejected with its SQLSTATE
-- as the code and the rest still apply.
CREATE OR REPLACE FUNCTION public.push_changes(p_mutations JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

-- =============================================================================
-- Pull: members gain joined_at
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pull_changes(p_cursors JSONB DEFAULT '{}'::JSONB)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    WITH mine AS (
        SELECT g.id, g.head_version, COALESCE((p_cursors->>(g.id::TEXT))::BIGINT, 0) AS since
        FROM public.groups g
        WHERE public.is_group_member(g.id)
    )
    SELECT jsonb_build_object(
        'group_ids', COALESCE((SELECT jsonb_agg(m.id) FROM mine m), '[]'::JSONB),
        'changes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'group_id', m.id,
                'version', m.head_version,
                'groups', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', g.id,
                        'name', g.name,
                        'base_currency', g.base_currency,
                        'created_by', g.created_by,
                        'created_at', g.created_at,
                        'deleted_at', g.deleted_at,
                        'row_version', g.row_version
                    ))
                    FROM public.groups g
                    WHERE g.id = m.id AND g.row_version > m.since
                ), '[]'::JSONB),
                'members', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', gm.id,
                        'group_id', gm.group_id,
                        'user_id', gm.user_id,
                        'display_name', gm.display_name,
                        'role', gm.role,
                        'joined_at', gm.joined_at,
                        'deleted_at', gm.deleted_at,
                        'row_version', gm.row_version
                    ))
                    FROM public.group_members gm
                    WHERE gm.group_id = m.id AND gm.row_version > m.since
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.push_changes(JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_changes(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
