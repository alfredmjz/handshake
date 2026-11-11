-- Migration: 012_group_codes
-- Description: One join code per group replaces invite links (owner decisions of 2026-11-10). The code is
-- 6 characters from an alphabet without lookalikes, made on the server, unique across groups; the owner can
-- reset it (group.recode). Guests get a personal code when they join, seen only by the group's owner and by
-- that guest, which lets them take their name back on a new device. Names are unique per group
-- (case-insensitive) for every new or changed name. group_invites and the 007 functions stay; devices stop
-- using them.

-- =============================================================================
-- Codes
-- =============================================================================

-- 6 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789 (31, no 0/O, 1/I/L). Bytes from 248 up are skipped so
-- every character is equally likely (248 = 8 × 31).
CREATE OR REPLACE FUNCTION private.random_code()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SET search_path = ''
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

-- What people type: any case, with or without the dash (or spaces).
CREATE OR REPLACE FUNCTION private.normalise_code(p_code TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT upper(regexp_replace(COALESCE(p_code, ''), '[\s-]', '', 'g'));
$$;

ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS join_code TEXT;
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_join_code_check;
ALTER TABLE public.groups ADD CONSTRAINT groups_join_code_check CHECK (join_code ~ '^[A-HJKMNP-Z2-9]{6}$');
CREATE UNIQUE INDEX IF NOT EXISTS groups_join_code_idx ON public.groups (join_code);

CREATE OR REPLACE FUNCTION private.new_join_code()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SET search_path = ''
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

-- =============================================================================
-- TABLE: guest_codes
-- =============================================================================

-- A guest's personal code, one per member row. Deleted (soft, so devices receive it) when the member stops
-- being a guest with a login: they added an email, the group was completed, their account was deleted.
CREATE TABLE IF NOT EXISTS public.guest_codes (
    member_id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (code ~ '^[A-HJKMNP-Z2-9]{6}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 0,
    FOREIGN KEY (group_id, member_id) REFERENCES public.group_members (group_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS guest_codes_code_idx ON public.guest_codes (group_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS guest_codes_version_idx ON public.guest_codes (group_id, row_version);

ALTER TABLE public.guest_codes ENABLE ROW LEVEL SECURITY;

-- The group's owner sees every guest code in it; a guest sees their own. Other members see none.
DROP POLICY IF EXISTS "Owners and the guest can view a guest code" ON public.guest_codes;
CREATE POLICY "Owners and the guest can view a guest code" ON public.guest_codes
    FOR SELECT TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.group_members gm
            WHERE gm.group_id = guest_codes.group_id
                AND gm.user_id = (SELECT auth.uid())
                AND gm.deleted_at IS NULL
                AND (gm.role = 'owner' OR gm.id = guest_codes.member_id)
        )
    );

REVOKE ALL ON public.guest_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.guest_codes TO authenticated;

-- Gives the guest a code unless they have one, stamped p_version.
CREATE OR REPLACE FUNCTION private.give_guest_code(p_group_id UUID, p_member_id UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_code TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM public.guest_codes WHERE member_id = p_member_id AND deleted_at IS NULL) THEN
        RETURN;
    END IF;
    LOOP
        v_code := private.random_code();
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.guest_codes WHERE group_id = p_group_id AND code = v_code AND deleted_at IS NULL
        );
    END LOOP;
    INSERT INTO public.guest_codes (member_id, group_id, code, row_version)
    VALUES (p_member_id, p_group_id, v_code, p_version)
    ON CONFLICT (member_id) DO UPDATE
    SET code = EXCLUDED.code, created_at = NOW(), deleted_at = NULL, row_version = EXCLUDED.row_version;
END;
$$;

-- Runs inside upgrade_guest, group.complete, delete_account and join_with_code, so each of them drops the
-- code in the same version as the member row.
CREATE OR REPLACE FUNCTION private.drop_guest_code()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    UPDATE public.guest_codes SET deleted_at = NOW(), row_version = NEW.row_version
    WHERE member_id = NEW.id AND deleted_at IS NULL;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS group_members_drop_guest_code ON public.group_members;
CREATE TRIGGER group_members_drop_guest_code
    AFTER UPDATE OF user_id, role ON public.group_members
    FOR EACH ROW WHEN (NEW.role <> 'guest' OR NEW.user_id IS NULL)
    EXECUTE FUNCTION private.drop_guest_code();

-- =============================================================================
-- TABLE: guest_handoffs
-- =============================================================================

-- A guest's name taken back with their personal code on another login. The login it left reads its own
-- rows through pull_changes (moved_away), so that device can say why the group went.
CREATE TABLE IF NOT EXISTS public.guest_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES public.group_members(id),
    from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS guest_handoffs_user_idx ON public.guest_handoffs (from_user_id);

ALTER TABLE public.guest_handoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view handoffs away from them" ON public.guest_handoffs;
CREATE POLICY "Users can view handoffs away from them" ON public.guest_handoffs
    FOR SELECT TO authenticated USING (from_user_id = (SELECT auth.uid()));

REVOKE ALL ON public.guest_handoffs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.guest_handoffs TO authenticated;

-- =============================================================================
-- Backfill: every group gets a join code, every guest with a login a personal code
-- =============================================================================

DO $$
DECLARE
    v_group_id UUID;
    v_version BIGINT;
    v_member public.group_members;
BEGIN
    FOR v_group_id IN SELECT id FROM public.groups WHERE join_code IS NULL ORDER BY id LOOP
        v_version := private.next_group_version(v_group_id);
        UPDATE public.groups SET join_code = private.new_join_code(), row_version = v_version WHERE id = v_group_id;
        FOR v_member IN
            SELECT * FROM public.group_members
            WHERE group_id = v_group_id AND role = 'guest' AND user_id IS NOT NULL AND deleted_at IS NULL
            ORDER BY id
        LOOP
            PERFORM private.give_guest_code(v_group_id, v_member.id, v_version);
        END LOOP;
    END LOOP;
END;
$$;

-- New groups (group.create) take a fresh code from the default.
ALTER TABLE public.groups ALTER COLUMN join_code SET DEFAULT private.new_join_code();
ALTER TABLE public.groups ALTER COLUMN join_code SET NOT NULL;

-- =============================================================================
-- The permission matrix gains group.recode
-- =============================================================================

-- As in 011, plus group.recode (owner). private.allowed_when_completed is unchanged: group.recode isn't in
-- its list, so a completed group refuses it.
CREATE OR REPLACE FUNCTION private.may(p_action TEXT, p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(CASE p_action
        WHEN 'group.rename' THEN p_role = 'owner'
        WHEN 'group.delete' THEN p_role = 'owner'
        WHEN 'group.complete' THEN p_role = 'owner'
        WHEN 'group.reopen' THEN p_role = 'owner'
        WHEN 'group.recode' THEN p_role = 'owner'
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

-- =============================================================================
-- Unique names
-- =============================================================================

-- Names are unique among the group's active people, ignoring case and outer spaces. p_except is the row
-- being named (a rename, or a retried add), which never clashes with itself.
CREATE OR REPLACE FUNCTION private.require_unique_name(p_group_id UUID, p_name TEXT, p_except UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path = ''
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

-- As in 004, plus the name check.
CREATE OR REPLACE FUNCTION private.apply_member_add(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'member.add');
    PERFORM private.require_unique_name(v_group_id, p_mutation->>'displayName', (p_mutation->>'memberId')::UUID);

    v_version := private.next_group_version(v_group_id);
    INSERT INTO public.group_members (id, group_id, display_name, role, row_version)
    VALUES ((p_mutation->>'memberId')::UUID, v_group_id, btrim(p_mutation->>'displayName'), 'member', v_version);
END;
$$;

-- As in 004, plus the name check, skipped when the name stays the same apart from case and spaces (old
-- duplicates stay as they are).
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
    IF lower(btrim(v_old)) <> lower(btrim(p_mutation->>'displayName')) THEN
        PERFORM private.require_unique_name(v_group_id, p_mutation->>'displayName', v_target);
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.group_members
    SET display_name = btrim(p_mutation->>'displayName'), updated_at = NOW(), row_version = v_version
    WHERE id = v_target;
END;
$$;

-- =============================================================================
-- Group code: reset by the owner
-- =============================================================================

-- group.recode { groupId }: a new code; the old one stops working at once.
CREATE OR REPLACE FUNCTION private.apply_group_recode(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
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

-- As in 004; a new owner also needs the group's guest codes, so they are stamped again for their pull.
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
    ELSE
        UPDATE public.guest_codes SET row_version = p_version WHERE group_id = p_group_id;
    END IF;
END;
$$;

-- =============================================================================
-- Joining with the group code (online only)
-- =============================================================================

-- The group a code opens: not deleted, not completed (its code works again once reopened). HS404 otherwise.
CREATE OR REPLACE FUNCTION private.find_group_by_code(p_code TEXT)
RETURNS public.groups
LANGUAGE plpgsql STABLE SET search_path = ''
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

-- What the join screen shows, signed out too. unclaimed: name-only people anyone may pick; returning:
-- guests with a personal code, for "I'm already in this group". Both by name, case-insensitive.
CREATE OR REPLACE FUNCTION public.preview_group(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
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

-- Joins the caller to the code's group and returns its id; nothing changes if they are in it already.
-- With p_personal_code: comes back as p_claim_member_id, a guest whose code it is (the row moves to the
-- caller's login and the old login loses the group). Otherwise, in this order: the caller's old row if they
-- left before; the name-only person p_claim_member_id; or someone new named p_display_name (else their
-- profile name), which must be unique in the group. Anonymous callers are guests and get a personal code.
CREATE OR REPLACE FUNCTION public.join_with_code(
    p_code TEXT,
    p_claim_member_id UUID DEFAULT NULL,
    p_display_name TEXT DEFAULT NULL,
    p_personal_code TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

-- =============================================================================
-- Pull: as in 011, plus groups.join_code, guest_codes and moved_away
-- =============================================================================

-- guest_codes rows are those the caller may see (RLS: the owner every guest's, a guest their own).
-- moved_away: groups the caller is no longer in because their guest name was taken back elsewhere.
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
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', g.id,
                        'name', g.name,
                        'note', g.note,
                        'base_currency', g.base_currency,
                        'join_code', g.join_code,
                        'created_by', g.created_by,
                        'created_at', g.created_at,
                        'deleted_at', g.deleted_at,
                        'completed_at', g.completed_at,
                        'completed_by_member_id', g.completed_by_member_id,
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
                ), '[]'::JSONB),
                'entries', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
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
                            SELECT jsonb_agg(jsonb_build_object(
                                'member_id', s.member_id,
                                'paid_cents', s.paid_cents,
                                'owed_cents', s.owed_cents,
                                'owed_to', COALESCE((
                                    SELECT jsonb_object_agg(p.payer_member_id, p.owed_cents)
                                    FROM public.ledger_share_parts p
                                    WHERE p.entry_id = s.entry_id AND p.member_id = s.member_id
                                ), '{}'::JSONB)
                            ) ORDER BY s.member_id)
                            FROM public.ledger_shares s
                            WHERE s.entry_id = e.id
                        ), '[]'::JSONB)
                    ))
                    FROM public.ledger_entries e
                    WHERE e.group_id = m.id AND e.row_version > m.since
                ), '[]'::JSONB),
                'conflicts', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
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
                    ))
                    FROM public.entry_conflicts c
                    WHERE c.group_id = m.id AND c.row_version > m.since
                ), '[]'::JSONB),
                'invites', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', i.id,
                        'group_id', i.group_id,
                        'claim_member_id', i.claim_member_id,
                        'created_by', i.created_by,
                        'created_at', i.created_at,
                        'expires_at', i.expires_at,
                        'revoked_at', i.revoked_at,
                        'row_version', i.row_version
                    ))
                    FROM public.group_invites i
                    WHERE i.group_id = m.id AND i.row_version > m.since
                ), '[]'::JSONB),
                'nudges', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', n.id,
                        'group_id', n.group_id,
                        'from_member_id', n.from_member_id,
                        'to_member_id', n.to_member_id,
                        'amount_cents', n.amount_cents,
                        'created_at', n.created_at,
                        'row_version', n.row_version
                    ))
                    FROM public.nudges n
                    WHERE n.group_id = m.id AND n.row_version > m.since
                ), '[]'::JSONB),
                'guest_codes', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'member_id', gc.member_id,
                        'group_id', gc.group_id,
                        'code', gc.code,
                        'created_at', gc.created_at,
                        'deleted_at', gc.deleted_at,
                        'row_version', gc.row_version
                    ))
                    FROM public.guest_codes gc
                    WHERE gc.group_id = m.id AND gc.row_version > m.since
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.preview_group(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.join_with_code(TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_group(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_with_code(TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
