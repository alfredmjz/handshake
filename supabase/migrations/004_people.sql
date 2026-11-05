-- Migration: 004_people
-- Description: Roles (owner, member, guest), when each person joined, completed groups, and the people
-- changes: member.add, member.rename, member.remove (which is also how someone leaves) and group.delete.
-- Who may do what is one matrix (spec decision 8, ADR-007): private.may() and
-- private.allowed_when_completed(), asked through private.require(). push_changes() reports an HS code
-- with every rejection, and apply_mutation() hands each change type to its own private.apply_<type>.

ALTER TABLE public.group_members DROP CONSTRAINT IF EXISTS group_members_role_check;
ALTER TABLE public.group_members
    ADD CONSTRAINT group_members_role_check CHECK (role IN ('owner', 'member', 'guest'));

-- Set whenever user_id is set. NULL for a name-only person.
ALTER TABLE public.group_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
UPDATE public.group_members SET joined_at = created_at WHERE user_id IS NOT NULL AND joined_at IS NULL;

-- A completed group is read-only apart from what the matrix allows (008 completes and reopens).
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS completed_by_member_id UUID REFERENCES public.group_members(id);

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- =============================================================================
-- The permission matrix
-- =============================================================================

-- Spec decision 8, held in step with src/lib/permissions.ts by tests/fixtures/permission-cases.ts.
CREATE OR REPLACE FUNCTION private.may(p_action TEXT, p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(CASE p_action
        WHEN 'group.rename' THEN p_role = 'owner'
        WHEN 'group.delete' THEN p_role = 'owner'
        WHEN 'group.complete' THEN p_role = 'owner'
        WHEN 'group.reopen' THEN p_role = 'owner'
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
    END, FALSE);
$$;

CREATE OR REPLACE FUNCTION private.allowed_when_completed(p_action TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(p_action IN ('group.delete', 'group.reopen', 'member.remove.self', 'payment.respond'), FALSE);
$$;

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

-- The one permission check every change makes, for the action it is doing. It first locks the group row,
-- so changes to one group apply one at a time and every check after this sees what the previous change
-- committed. Returns the caller's member row; HS403 if they are not an active member, the group is
-- deleted, the group is completed and the action isn't allowed then, or their role may not.
CREATE OR REPLACE FUNCTION private.require(p_user UUID, p_group_id UUID, p_action TEXT)
RETURNS public.group_members
LANGUAGE plpgsql SET search_path = ''
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

-- Replaced by private.require (ADR-007).
DROP FUNCTION IF EXISTS private.require_member(UUID, UUID, TEXT[], BOOLEAN);

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
    -- An account rule outside the matrix.
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
    PERFORM private.require(p_user, v_group_id, 'group.rename');

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
    PERFORM private.require(p_user, v_group_id, 'group.delete');

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET deleted_at = NOW(), updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

-- A name-only person: no user yet, so they can be in bills before they join.
CREATE OR REPLACE FUNCTION private.apply_member_add(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'member.add');

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
    v_me := private.caller_member(p_user, v_group_id);
    PERFORM private.require(p_user, v_group_id,
        CASE WHEN v_target = v_me.id THEN 'member.rename.self' ELSE 'member.rename.others' END);

    IF NOT EXISTS (SELECT 1 FROM public.group_members WHERE id = v_target AND group_id = v_group_id) THEN
        RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.group_members
    SET display_name = btrim(p_mutation->>'displayName'), updated_at = NOW(), row_version = v_version
    WHERE id = v_target;
END;
$$;

-- Hands a group whose owner is going over to the full member who joined first (joined_at, then id),
-- or deletes it when no full member is left, even if guests remain. Stamps p_version.
CREATE OR REPLACE FUNCTION private.hand_over(p_group_id UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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
    END IF;
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

-- pull_changes() gets its final shape in 007, once every synced table exists.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.push_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_changes(JSONB) TO authenticated;
