-- Migration: 008_complete
-- Description: Completing a group, and deleting an account. group.complete (owner) makes the group
-- read-only and, in the same transaction, takes away the access of every guest who never added an email:
-- their member row becomes a name-only person, so bills and debts still add up, and a guest login left in
-- no other group is deleted. Pending payments stay pending. group.reopen (owner) makes it editable again;
-- deleted logins don't come back. delete_account() (spec decision 19) leaves the person's history behind
-- under their name and removes their login.

-- A deleted account must not take the groups and links it made with it.
ALTER TABLE public.groups ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_created_by_fkey;
ALTER TABLE public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.group_invites ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.group_invites DROP CONSTRAINT IF EXISTS group_invites_created_by_fkey;
ALTER TABLE public.group_invites
    ADD CONSTRAINT group_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- =============================================================================
-- Changes
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_group_complete(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

CREATE OR REPLACE FUNCTION private.apply_group_reopen(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

-- =============================================================================
-- Deleting an account (online only)
-- =============================================================================

-- In one transaction, for every group the caller has a row in: their pending payments are undone, their
-- row becomes a name-only person with the same name (so every bill, payment and debt still shows who it
-- was), and a group they own passes on (or is deleted with no full member left). Then their login goes.
-- Each group takes one version, so the others pull the change. Guests may delete too.
CREATE OR REPLACE FUNCTION public.delete_account()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;
