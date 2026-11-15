-- ============================================================================
-- 021: profile pictures. One per account, kept on the profile and copied onto each of its member rows, so the
-- rest of a group pulls it with the member row. NULL is the drawn face. set_my_picture() changes it everywhere at
-- once; a new or claimed membership takes the profile's; a member row without a login never has one.
-- ============================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS picture TEXT;
ALTER TABLE public.group_members ADD COLUMN IF NOT EXISTS picture TEXT;

-- A small square picture as a data URL (made small on the device first), or NULL. isProfilePicture()
-- (src/lib/profile-picture.ts) accepts the same.
CREATE OR REPLACE FUNCTION private.profile_picture(p_picture TEXT) RETURNS TEXT
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
BEGIN
    IF p_picture IS NULL THEN
        RETURN NULL;
    END IF;
    IF char_length(p_picture) > 40000
        OR p_picture !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$' THEN
        RAISE EXCEPTION 'That isn''t a picture' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_picture;
END;
$$;

REVOKE ALL ON FUNCTION private.profile_picture(TEXT) FROM PUBLIC;

-- Keeps a member row's picture the login's: taken from the profile when a login joins or claims the row, and
-- dropped when the row loses its login (the account was deleted).
CREATE OR REPLACE FUNCTION private.member_picture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        NEW.picture := NULL;
    ELSIF TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        NEW.picture := (SELECT p.picture FROM public.profiles p WHERE p.id = NEW.user_id);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.member_picture() FROM PUBLIC;

DROP TRIGGER IF EXISTS member_picture ON public.group_members;
CREATE TRIGGER member_picture BEFORE INSERT OR UPDATE OF user_id, picture ON public.group_members
    FOR EACH ROW EXECUTE FUNCTION private.member_picture();

-- Online only. Sets the caller's picture (NULL for the drawn face) on their profile and on every member row they
-- have, each group taking a new version so its people pull it.
CREATE OR REPLACE FUNCTION public.set_my_picture(p_picture TEXT) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_user UUID := (SELECT auth.uid());
    v_picture TEXT;
    v_group_id UUID;
    v_version BIGINT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
    END IF;
    v_picture := private.profile_picture(p_picture);

    UPDATE public.profiles SET picture = v_picture WHERE id = v_user;

    FOR v_group_id IN
        SELECT DISTINCT group_id FROM public.group_members
        WHERE user_id = v_user AND picture IS DISTINCT FROM v_picture
        ORDER BY group_id
    LOOP
        v_version := private.next_group_version(v_group_id);
        UPDATE public.group_members
        SET picture = v_picture, updated_at = NOW(), row_version = v_version
        WHERE group_id = v_group_id AND user_id = v_user;
    END LOOP;
END;
$$;

ALTER FUNCTION public.set_my_picture(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_my_picture(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_picture(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pull_member_row(gm public.group_members) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
    SELECT jsonb_build_object(
        'id', gm.id,
        'group_id', gm.group_id,
        'user_id', gm.user_id,
        'display_name', gm.display_name,
        'picture', gm.picture,
        'role', gm.role,
        'joined_at', gm.joined_at,
        'deleted_at', gm.deleted_at,
        'row_version', gm.row_version
    );
$$;
