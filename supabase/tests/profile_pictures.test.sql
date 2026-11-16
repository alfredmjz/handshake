-- ============================================================================
-- pgTAP tests for profile pictures (migration 021). A picture (one of the 30 drawn faces, or a small photo)
-- belongs to the account: set_my_picture() keeps it
-- on the profile and copies it onto every member row the account has, each taking the group's next version so
-- the others pull it. A login that joins or claims a row brings its picture; a row without a login has none.
-- Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();
\ir prelude.psql

-- ---------------------------------------------------------------------------
-- Helpers (the shared ones are in prelude.psql)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.set_picture(p_user UUID, p_picture TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT pg_temp.as_user(p_user, format('SELECT public.set_my_picture(%L)', p_picture));
$$;
CREATE FUNCTION pg_temp.picture_of(p_member UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT picture FROM public.group_members WHERE id = p_member;
$$;
CREATE FUNCTION pg_temp.member_version(p_member UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.group_members WHERE id = p_member;
$$;
CREATE FUNCTION pg_temp.profile_picture(p_user UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT picture FROM public.profiles WHERE id = p_user;
$$;
-- A member row as p_user pulls it.
CREATE FUNCTION pg_temp.pulled_member(p_user UUID, p_member UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT m FROM jsonb_array_elements(pg_temp.pull(p_user)->'changes') c, jsonb_array_elements(c->'members') m
    WHERE m->>'id' = p_member::TEXT;
$$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner, a1), Sam (b1, added by name and joined with the group code) and Pat (p1, name only).
-- ---------------------------------------------------------------------------
SELECT pg_temp.add_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@pictures.test', 'Alex');
SELECT pg_temp.add_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@pictures.test', 'Sam');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Japan", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'Alex adds Sam by name');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}'), 'applied', 'Alex adds Pat by name');
SELECT is(pg_temp.join_code('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('10000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins with the group code');

SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000b1'), NULL, 'nobody has a picture to begin with: the devices draw a face');
SELECT is(pg_temp.profile_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), NULL, '... nor on the profile');

-- ---------------------------------------------------------------------------
-- Setting a picture: on the profile and the member row, which the others pull
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE before_set AS SELECT pg_temp.member_version('20000000-0000-0000-0000-0000000000b1') AS v;
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'data:image/webp;base64,UklGRg=='), 'ok', 'Sam sets a picture');
SELECT is(pg_temp.profile_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'data:image/webp;base64,UklGRg==', '... kept on his profile');
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000b1'), 'data:image/webp;base64,UklGRg==', '... and on his member row');
SELECT ok(pg_temp.member_version('20000000-0000-0000-0000-0000000000b1') > (SELECT v FROM before_set), '... which took a new version');
SELECT is(pg_temp.pulled_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '20000000-0000-0000-0000-0000000000b1')->>'picture', 'data:image/webp;base64,UklGRg==', '... so Alex pulls it');
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000a1'), NULL, 'Alex keeps the drawn face');

-- ---------------------------------------------------------------------------
-- A login brings its picture to a row it joins, claims or starts with
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Rent", "displayName": "Alex"}'), 'applied', 'Alex creates group 2');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000b2", "displayName": "Sam"}'), 'applied', 'Alex adds Sam by name');
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000b2'), NULL, 'a name-only row has no picture');
SELECT is(pg_temp.join_code('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('10000000-0000-0000-0000-000000000002'), '20000000-0000-0000-0000-0000000000b2'), '10000000-0000-0000-0000-000000000002'::UUID, 'Sam claims it with the group code');
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000b2'), 'data:image/webp;base64,UklGRg==', '... and it takes his picture');

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000b3", "name": "Ski", "displayName": "Sam"}'), 'applied', 'Sam starts group 3');
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000b3'), 'data:image/webp;base64,UklGRg==', '... with his picture on his row');

-- ---------------------------------------------------------------------------
-- Changing or removing it reaches every group
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'data:image/png;base64,iVBORw0KGgo='), 'ok', 'Sam changes his picture');
SELECT is(
    ARRAY(SELECT picture FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' ORDER BY id),
    ARRAY['data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo='],
    '... on all three of his rows'
);
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL), 'ok', 'Sam goes back to the drawn face');
SELECT is(
    ARRAY(SELECT picture FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' ORDER BY id),
    ARRAY[NULL, NULL, NULL]::TEXT[],
    '... on all three of his rows'
);
SELECT is(pg_temp.profile_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), NULL, '... and on his profile');
SELECT is(pg_temp.pulled_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '20000000-0000-0000-0000-0000000000b1')->>'picture', NULL, '... which Alex pulls');

-- ---------------------------------------------------------------------------
-- Only small pictures, only through set_my_picture
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'data:image/svg+xml;base64,PHN2Zz4='), 'HS422', 'an SVG, which can carry scripts, is refused');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'https://example.com/me.png'), 'HS422', 'a link to a picture elsewhere is refused');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'data:image/png;base64,' || repeat('A', 40000)), 'HS422', 'a picture over 40,000 characters is refused');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'data:image/png;base64,' || repeat('A', 39978)), 'ok', 'one of exactly 40,000 is kept');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL), 'ok', '... (and removed again)');
SELECT is(pg_temp.profile_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), NULL, 'none of the refused ones were kept');

-- ---------------------------------------------------------------------------
-- Or one of the 30 drawn faces, by its slot
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'face:0'), 'ok', 'Sam picks the first drawn face');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'face:29'), 'ok', '... then the last');
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000b1'), 'face:29', '... kept on his member row');
SELECT is(pg_temp.pulled_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '20000000-0000-0000-0000-0000000000b1')->>'picture', 'face:29', '... which Alex pulls');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'face:30'), 'HS422', 'there is no 31st face');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'face:07'), 'HS422', 'a slot with a leading zero is refused');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'face:-1'), 'HS422', 'a negative slot is refused');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'face:'), 'HS422', 'a face with no slot is refused');
SELECT is(pg_temp.profile_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'face:29', '... and he keeps the last face');
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL), 'ok', '... until he goes back to the default');

SELECT is(pg_temp.sqlstate_signed_out('SELECT public.set_my_picture(NULL)'), '42501', 'signed out, it can''t be called');
SELECT is(pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $$UPDATE public.group_members SET picture = 'data:image/png;base64,iVBORw0KGgo=' WHERE id = '20000000-0000-0000-0000-0000000000b1'$$), '42501', 'Alex can''t write a picture onto Sam''s row');
SELECT is(pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $$UPDATE public.profiles SET picture = 'data:image/png;base64,iVBORw0KGgo=' WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$), '42501', 'Sam can''t write his profile''s picture past the check');

UPDATE public.group_members SET picture = 'data:image/png;base64,iVBORw0KGgo=' WHERE id = '20000000-0000-0000-0000-0000000000f1';
SELECT is(pg_temp.picture_of('20000000-0000-0000-0000-0000000000f1'), NULL, 'a row without a login never keeps a picture');

-- ---------------------------------------------------------------------------
-- Deleting the account takes the picture off the rows it leaves behind
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.set_picture('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'data:image/png;base64,iVBORw0KGgo='), 'ok', 'Sam sets a picture again');
SELECT is(pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SELECT public.delete_account()'), 'ok', 'Sam deletes his account');
SELECT is(
    ARRAY(SELECT picture FROM public.group_members WHERE id IN ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b2') ORDER BY id),
    ARRAY[NULL, NULL]::TEXT[],
    '... and his name-only rows keep no picture'
);
SELECT is(pg_temp.pulled_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '20000000-0000-0000-0000-0000000000b1')->>'picture', NULL, '... which Alex pulls');

SELECT * FROM finish();
ROLLBACK;
