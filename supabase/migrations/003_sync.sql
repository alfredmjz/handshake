-- Migration: 003_sync
-- Description: The sync protocol. Devices write locally, queue each change as a mutation, and later
-- send the queue to push_changes(). pull_changes() returns what changed in each of the caller's groups
-- since the version the device last saw.

-- Mutations already applied, so a retried push (the reply was lost) is not applied twice.
CREATE TABLE IF NOT EXISTS public.sync_mutations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sync_mutations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_mutations FROM anon, authenticated;

-- The UPDATE locks the group row until the caller's transaction ends, so versions within a group
-- commit in order and a pull can never move its cursor past a write that is still in flight.
CREATE OR REPLACE FUNCTION private.next_group_version(p_group_id UUID)
RETURNS BIGINT
LANGUAGE sql SET search_path = ''
AS $$
    UPDATE public.groups SET head_version = head_version + 1 WHERE id = p_group_id RETURNING head_version;
$$;

CREATE OR REPLACE FUNCTION private.apply_mutation(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_type TEXT := p_mutation->>'type';
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    CASE v_type
    WHEN 'group.create' THEN
        INSERT INTO public.groups (id, name, base_currency, created_by)
        VALUES (v_group_id, btrim(p_mutation->>'name'), upper(p_mutation->>'baseCurrency'), p_user);

        v_version := private.next_group_version(v_group_id);
        UPDATE public.groups SET row_version = v_version WHERE id = v_group_id;

        INSERT INTO public.group_members (id, group_id, user_id, display_name, role, row_version)
        VALUES (
            (p_mutation->>'memberId')::UUID,
            v_group_id,
            p_user,
            COALESCE(
                NULLIF(btrim(p_mutation->>'displayName'), ''),
                (SELECT display_name FROM public.profiles WHERE id = p_user)
            ),
            'owner',
            v_version
        );

    WHEN 'group.rename' THEN
        IF NOT public.is_group_member(v_group_id) THEN
            RAISE EXCEPTION 'You are not a member of this group';
        END IF;

        v_version := private.next_group_version(v_group_id);
        UPDATE public.groups
        SET name = btrim(p_mutation->>'name'), updated_at = NOW(), row_version = v_version
        WHERE id = v_group_id AND deleted_at IS NULL;

    ELSE
        RAISE EXCEPTION 'Unknown change type: %', v_type;
    END CASE;
END;
$$;

-- Applies each mutation in order, each in its own savepoint: a bad one is rejected and the rest still apply.
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
            v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('id', v_mutation->>'id', 'reason', SQLERRM));
        END;
    END LOOP;

    RETURN jsonb_build_object('applied', v_applied, 'rejected', v_rejected);
END;
$$;

-- p_cursors maps group id -> the last version this device has. STABLE gives the whole call one
-- snapshot, so each returned version matches the rows returned with it.
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

REVOKE EXECUTE ON FUNCTION private.next_group_version(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.apply_mutation(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.push_changes(JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_changes(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
