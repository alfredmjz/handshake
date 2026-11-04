-- Migration: 007_invites
-- Description: Invite links, guests and joining. The owner makes a link (invite.create, which works
-- offline; the server keeps only the token's SHA-256). Someone who isn't a member yet can't push or
-- pull, so joining is two online functions: preview_invite() (works signed out) and join_group().
-- Guests are Supabase anonymous users; upgrade_guest() makes them members once they add an email.

-- =============================================================================
-- TABLE: group_invites
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.group_invites (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    -- Hex SHA-256 of the token. Never sent to devices: the creator's device keeps the token itself.
    token_hash TEXT NOT NULL UNIQUE,
    -- The non-member this link is for: whoever opens it becomes them.
    claim_member_id UUID REFERENCES public.group_members(id),
    created_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS group_invites_version_idx ON public.group_invites (group_id, row_version);

ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their group's invites" ON public.group_invites;
CREATE POLICY "Members can view their group's invites" ON public.group_invites
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

REVOKE ALL ON public.group_invites FROM anon, authenticated;
GRANT SELECT (id, group_id, claim_member_id, created_by, created_at, expires_at, revoked_at, row_version)
    ON public.group_invites TO authenticated;

-- =============================================================================
-- Changes
-- =============================================================================

CREATE OR REPLACE FUNCTION private.hash_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

-- The token is 32 random bytes in base64url, made on the device. A link lasts at most 14 days from when
-- the server receives it, whatever expiresAt the device sent.
CREATE OR REPLACE FUNCTION private.apply_invite_create(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_token TEXT := p_mutation->>'token';
    v_claim UUID := (p_mutation->>'claimMemberId')::UUID;
BEGIN
    PERFORM private.require_member(p_user, v_group_id, ARRAY['owner']);

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
$$;

CREATE OR REPLACE FUNCTION private.apply_invite_revoke(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_invite public.group_invites;
BEGIN
    PERFORM private.require_member(p_user, v_group_id, ARRAY['owner']);

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

-- =============================================================================
-- Joining (online only)
-- =============================================================================

-- The live invite for a token: not revoked, not expired, its group not deleted. HS404 otherwise.
CREATE OR REPLACE FUNCTION private.find_invite(p_token TEXT)
RETURNS public.group_invites
LANGUAGE plpgsql STABLE SET search_path = ''
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
        AND g.deleted_at IS NULL;

    IF v_invite.id IS NULL THEN
        RAISE EXCEPTION 'This invite link doesn''t work any more' USING ERRCODE = 'HS404';
    END IF;
    RETURN v_invite;
END;
$$;

-- What the join screen shows before anyone picks "Create an account" or "Continue as guest", so it is
-- open to signed-out callers too. The token is 256 random bits, so it can't be guessed. claimMemberId is
-- the link's non-member while they can still be claimed, else NULL.
CREATE OR REPLACE FUNCTION public.preview_invite(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
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

-- Joins the caller to the invite's group and returns its id; does nothing if they are in it already.
-- The caller becomes, in this order: their old member row if they left before (history included); the
-- non-member they picked, or the link's; or a new member named p_display_name (else their profile name).
-- Anonymous callers join as guests.
CREATE OR REPLACE FUNCTION public.join_group(
    p_token TEXT,
    p_claim_member_id UUID DEFAULT NULL,
    p_display_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

-- After a guest adds an email (updateUser + the 6-digit code), their user id stays the same; this turns
-- their guest rows into member rows in every group and copies the email into their profile.
CREATE OR REPLACE FUNCTION public.upgrade_guest()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

-- =============================================================================
-- Pull: invites, without token_hash
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
                        'recorded_via', e.recorded_via,
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
                                'owed_cents', s.owed_cents
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
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.preview_invite(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.join_group(TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.upgrade_guest() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_invite(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_group(TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_guest() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
