-- Migration: 002_groups
-- Description: Groups and their members. Clients only read these tables; every write goes through
-- push_changes() (003_sync.sql), which stamps each change with a per-group version for sync.

CREATE TABLE IF NOT EXISTS public.groups (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    base_currency CHAR(3) NOT NULL DEFAULT 'CAD' CHECK (base_currency ~ '^[A-Z]{3}$'),
    created_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    -- The last version handed out in this group; private.next_group_version() moves it.
    head_version BIGINT NOT NULL DEFAULT 0,
    row_version BIGINT NOT NULL DEFAULT 0
);

-- user_id is NULL for someone added by name who hasn't joined yet.
CREATE TABLE IF NOT EXISTS public.group_members (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 60),
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_user_idx
    ON public.group_members (group_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_members_user_idx
    ON public.group_members (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS group_members_version_idx
    ON public.group_members (group_id, row_version);

-- SECURITY DEFINER so the policy on group_members can call it without recursing into itself.
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.group_members
        WHERE group_id = p_group_id AND user_id = (SELECT auth.uid()) AND deleted_at IS NULL
    );
$$;

REVOKE EXECUTE ON FUNCTION public.is_group_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_group_member(UUID) TO authenticated;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their groups" ON public.groups;
CREATE POLICY "Members can view their groups" ON public.groups
    FOR SELECT TO authenticated USING (public.is_group_member(id));

DROP POLICY IF EXISTS "Members can view their group's members" ON public.group_members;
CREATE POLICY "Members can view their group's members" ON public.group_members
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

REVOKE ALL ON public.groups, public.group_members FROM anon, authenticated;
GRANT SELECT ON public.groups, public.group_members TO authenticated;
