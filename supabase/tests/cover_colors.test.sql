-- ============================================================================
-- pgTAP tests for cover colours (migration 015). A group's cover_color is a key on the colour board
-- ("h0s0" to "h17s4") or NULL for the default; group.recolor sets it. Anyone in the group may (owner, member
-- or guest), but not once the group is completed. Everything goes through push_changes() and pull_changes()
-- and is rolled back.
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
CREATE FUNCTION pg_temp.recolor(p_color JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'group.recolor', 'groupId', '10000000-0000-0000-0000-000000000001', 'color', p_color);
$$;
CREATE FUNCTION pg_temp.color_of() RETURNS TEXT LANGUAGE sql AS $$
    SELECT cover_color FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001';
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
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@covers.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@covers.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'kim@covers.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Kim"}');

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Japan", "displayName": "Alex"}'),
    'applied',
    'Alex creates a group'
);
SELECT is(pg_temp.color_of(), NULL, 'a new group has no colour of its own: the devices show the default');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'Alex adds Sam by name');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins with the group code');

-- ---------------------------------------------------------------------------
-- Anyone in the group may recolour it; it syncs to everyone
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('"h7s2"')), 'applied', 'Alex (owner) paints the cover h7s2');
SELECT is(pg_temp.color_of(), 'h7s2', '... stored');
SELECT is(pg_temp.pulled_group()->>'cover_color', 'h7s2', '... and pulled by Sam as cover_color');

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.recolor('"h17s4"')), 'applied', 'Sam (member) repaints it h17s4, the board''s last cell');
SELECT is(pg_temp.color_of(), 'h17s4', '... stored');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.recolor('"h0s0"')), 'applied', 'h0s0, the first cell, is a colour too');

SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.recolor('"h3s1"')), 'HS403', 'Kim, who isn''t in the group, can''t');
SELECT is(pg_temp.color_of(), 'h0s0', '... and it stays h0s0');

-- Each recolour takes the next group version, so the others pull it.
CREATE TEMP TABLE before_recolor AS SELECT pg_temp.version_of() AS v;
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('"h4s3"')), 'applied', 'Alex paints it h4s3');
SELECT ok(pg_temp.version_of() > (SELECT v FROM before_recolor), '... and the group took a new version');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('null')), 'applied', 'null goes back to the default');
SELECT is(pg_temp.color_of(), NULL, '... stored as no colour');

-- ---------------------------------------------------------------------------
-- Only keys on the board
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('"h18s0"')), 'HS422', 'h18 is past the last column');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('"h3s5"')), 'HS422', 's5 is past the last row');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('"#ff0000"')), 'HS422', 'a hex colour is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('"h03s1"')), 'HS422', 'a padded column number is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.recolor('7')), 'HS422', 'a colour that isn''t text is refused');
SELECT is(pg_temp.color_of(), NULL, '... and none of them were stored');

-- ---------------------------------------------------------------------------
-- Not in a completed group
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex completes the group');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.recolor('"h9s2"')), 'HS403', 'a completed group can''t be recoloured');
SELECT is(pg_temp.color_of(), NULL, '... and keeps its colour');

SELECT * FROM finish();
ROLLBACK;
