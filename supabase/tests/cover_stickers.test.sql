-- ============================================================================
-- pgTAP tests for cover stickers (migration 016). A group's cover_sticker is one of the hand drawings
-- ("hand:travel"), one emoji ("emoji:🇯🇵"), a small uploaded picture as a data URL, or NULL for the default;
-- group.sticker sets it. Anyone in the group may (owner, member or guest), but not once the group is completed.
-- Everything goes through push_changes() and pull_changes() and is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- ---------------------------------------------------------------------------
-- Helpers: act as a signed-in user
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.sign_in(p_user UUID) RETURNS VOID LANGUAGE sql AS $$
    SELECT set_config('request.jwt.claims', json_build_object(
        'sub', p_user,
        'role', 'authenticated',
        'is_anonymous', COALESCE((SELECT is_anonymous FROM auth.users WHERE id = p_user), FALSE)
    )::TEXT, true);
$$;
CREATE FUNCTION pg_temp.push_signed_in(p_mutations JSONB) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.push_changes(p_mutations);
$$;
CREATE FUNCTION pg_temp.pull_signed_in(p_cursors JSONB) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.pull_changes(p_cursors);
$$;
CREATE FUNCTION pg_temp.join_signed_in(p_code TEXT, p_claim UUID) RETURNS UUID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.join_with_code(p_code, p_claim, NULL, NULL);
$$;
CREATE FUNCTION pg_temp.push(p_user UUID, p_mutation JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.push_signed_in(jsonb_build_array(jsonb_build_object('id', gen_random_uuid()) || p_mutation));
END $$;
-- 'applied', or the rejection's code.
CREATE FUNCTION pg_temp.try(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE(r#>>'{rejected,0,code}', 'applied') FROM pg_temp.push(p_user, p_mutation) r;
$$;
CREATE FUNCTION pg_temp.join(p_user UUID, p_claim UUID) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.join_signed_in((SELECT join_code FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001'), p_claim);
END $$;
CREATE FUNCTION pg_temp.stick(p_sticker JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'group.sticker', 'groupId', '10000000-0000-0000-0000-000000000001', 'sticker', p_sticker);
$$;
CREATE FUNCTION pg_temp.sticker_of() RETURNS TEXT LANGUAGE sql AS $$
    SELECT cover_sticker FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001';
$$;
CREATE FUNCTION pg_temp.version_of() RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001';
$$;
-- The group as Sam pulls it.
CREATE FUNCTION pg_temp.pulled_group() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_pull JSONB;
BEGIN
    PERFORM pg_temp.sign_in('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    v_pull := pg_temp.pull_signed_in('{}'::JSONB);
    RETURN (SELECT g FROM jsonb_array_elements(v_pull->'changes') c, jsonb_array_elements(c->'groups') g
        WHERE g->>'id' = '10000000-0000-0000-0000-000000000001');
END $$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner) and Sam (member, joined with the group code). Kim is in no group.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@stickers.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@stickers.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'kim@stickers.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Kim"}');

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Japan", "displayName": "Alex"}'),
    'applied',
    'Alex creates a group'
);
SELECT is(pg_temp.sticker_of(), NULL, 'a new group has no sticker of its own: the devices show the default');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'Alex adds Sam by name');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins with the group code');

-- ---------------------------------------------------------------------------
-- Anyone in the group may change it; it syncs to everyone
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"hand:travel"')), 'applied', 'Alex (owner) puts the travel hand on the cover');
SELECT is(pg_temp.sticker_of(), 'hand:travel', '... stored');
SELECT is(pg_temp.pulled_group()->>'cover_sticker', 'hand:travel', '... and pulled by Sam as cover_sticker');

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.stick('"emoji:🇯🇵"')), 'applied', 'Sam (member) swaps it for a flag emoji');
SELECT is(pg_temp.sticker_of(), 'emoji:🇯🇵', '... stored as it was sent');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.stick('"emoji:👨‍👩‍👧‍👦"')), 'applied', 'an emoji joined from several (a family, 7 code points) is one sticker');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.stick('"data:image/png;base64,iVBORw0KGgo="')), 'applied', 'an uploaded picture, as a data URL');
SELECT is(pg_temp.sticker_of(), 'data:image/png;base64,iVBORw0KGgo=', '... stored');

SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.stick('"hand:food"')), 'HS403', 'Kim, who isn''t in the group, can''t');
SELECT is(pg_temp.sticker_of(), 'data:image/png;base64,iVBORw0KGgo=', '... and it stays the picture');

-- Each change takes the next group version, so the others pull it.
CREATE TEMP TABLE before_stick AS SELECT pg_temp.version_of() AS v;
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"hand:fun"')), 'applied', 'Alex puts the fun hand on');
SELECT ok(pg_temp.version_of() > (SELECT v FROM before_stick), '... and the group took a new version');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('null')), 'applied', 'null goes back to the default');
SELECT is(pg_temp.sticker_of(), NULL, '... stored as no sticker');

-- ---------------------------------------------------------------------------
-- Only the three shapes, and only small
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"hand:shake"')), 'HS422', 'the shake is not one of the cover hands');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"emoji:hi"')), 'HS422', 'letters are not an emoji');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"emoji:"')), 'HS422', 'an empty emoji is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"emoji:🎉 🎉"')), 'HS422', 'two emoji with a space between are refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"emoji:🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉"')), 'HS422', 'seventeen code points is more than one emoji');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"data:image/svg+xml;base64,PHN2Zz4="')), 'HS422', 'an SVG, which can carry scripts, is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('"https://example.com/sticker.png"')), 'HS422', 'a link to a picture elsewhere is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick('7')), 'HS422', 'a sticker that isn''t text is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.stick(to_jsonb('data:image/png;base64,' || repeat('A', 120000)))), 'HS422', 'a picture over 120,000 characters is refused');
SELECT is(pg_temp.sticker_of(), NULL, '... and none of them were stored');

-- ---------------------------------------------------------------------------
-- Not in a completed group
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex completes the group');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.stick('"hand:stay"')), 'HS403', 'a completed group''s sticker can''t be changed');
SELECT is(pg_temp.sticker_of(), NULL, '... and it keeps the default');

SELECT * FROM finish();
ROLLBACK;
