-- ============================================================================
-- pgTAP tests for the name checks (migration 019): group names are 1 to 80 characters and people's names
-- 1 to 60, after trimming, refused with HS422 at the point planChange checks them. Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(19);
\ir prelude.psql

-- 'ok', or the error's SQLSTATE and message.
CREATE FUNCTION pg_temp.name_error(p_name TEXT, p_max INTEGER) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM private.require_name(p_name, p_max, 'A name');
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE || ' ' || SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- private.require_name
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.name_error('Jo', 60), 'ok', 'a short name is fine');
SELECT is(pg_temp.name_error(repeat('x', 60), 60), 'ok', 'a name at the limit is fine');
SELECT is(pg_temp.name_error('  ' || repeat('x', 60) || '  ', 60), 'ok', 'outer spaces do not count');
SELECT is(pg_temp.name_error(repeat('x', 61), 60), 'HS422 A name must be 1 to 60 characters', 'one over the limit is refused');
SELECT is(pg_temp.name_error('   ', 60), 'HS422 A name must be 1 to 60 characters', 'a blank name is refused');
SELECT is(pg_temp.name_error(NULL, 60), 'HS422 A name must be 1 to 60 characters', 'a missing name is refused');

-- ---------------------------------------------------------------------------
-- Through push_changes. Alex owns group 1, Sam is a member, Kim a guest.
-- ---------------------------------------------------------------------------
SELECT pg_temp.add_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@names.test', 'Alex');
SELECT pg_temp.add_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@names.test', 'Sam');

SELECT is(
    pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000009", "memberId": "20000000-0000-0000-0000-0000000000a9", "name": "  ", "displayName": "Alex"}'),
    'HS422 A group name must be 1 to 80 characters',
    'group.create: a blank group name is refused'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'group.create', 'groupId', '10000000-0000-0000-0000-000000000009', 'memberId', '20000000-0000-0000-0000-0000000000a9', 'name', repeat('x', 81), 'displayName', 'Alex')),
    'HS422',
    'group.create: a group name of 81 characters is refused'
);
SELECT is(
    pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000009", "memberId": "20000000-0000-0000-0000-0000000000a9", "name": "Banff", "displayName": "  "}'),
    'HS422 A name must be 1 to 60 characters',
    'group.create: a blank owner''s name is refused'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000008", "memberId": "20000000-0000-0000-0000-0000000000a8", "name": "Jasper"}'),
    'applied',
    'group.create: with no owner''s name sent at all, the group is made'
);
SELECT is(
    (SELECT display_name FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000a8'),
    (SELECT display_name FROM public.profiles WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'group.create: ...and the owner takes their profile name'
);

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "  Banff  ", "displayName": " Alex "}'),
    'applied',
    'Alex creates group 1'
);
SELECT is(
    (SELECT name || '/' || (SELECT display_name FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000a1') FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001'),
    'Banff/Alex',
    'names are stored trimmed'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}'),
    'applied',
    'Alex adds Pat by name'
);

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": " "}'),
    'HS422',
    'group.rename: a blank group name is refused'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": " "}'),
    'HS403',
    'group.rename: someone outside the group is refused for who they are first'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f2", "displayName": "  "}'),
    'HS422',
    'member.add: a blank name is refused'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f2", "displayName": " pat "}'),
    'HS409',
    'member.add: a good name already in the group is still a clash'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.rename', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', '20000000-0000-0000-0000-0000000000f1', 'displayName', repeat('x', 61))),
    'HS422',
    'member.rename: a name of 61 characters is refused'
);

SELECT * FROM finish();
ROLLBACK;
