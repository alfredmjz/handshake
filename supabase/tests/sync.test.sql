-- ============================================================================
-- pgTAP tests for the sync protocol (migrations 003 and 004): push_changes() applies queued mutations
-- once, rejects what the caller may not do with an HS code (or the SQLSTATE of what failed), and
-- pull_changes() returns only changes past each cursor.
-- Run against the local Supabase with `bun run test:db`. Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, instance_id, aud, role)
VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'alex@sync-test.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'sam@sync-test.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

SELECT is(
    (SELECT display_name FROM public.profiles WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    'alex',
    'a new user gets a profile named after their email'
);

CREATE OR REPLACE FUNCTION pg_temp.create_group(p_mutation UUID) RETURNS JSONB
LANGUAGE sql AS $$
    SELECT public.push_changes(jsonb_build_array(jsonb_build_object(
        'id', p_mutation,
        'type', 'group.create',
        'groupId', 'a0000000-0000-0000-0000-0000000000a1',
        'memberId', 'a0000000-0000-0000-0000-0000000000b1',
        'name', '  Japan 2027 ',
        'baseCurrency', 'jpy',
        'displayName', 'Alex'
    )));
$$;

CREATE OR REPLACE FUNCTION pg_temp.rename(p_mutation UUID, p_name TEXT) RETURNS JSONB
LANGUAGE sql AS $$
    SELECT public.push_changes(jsonb_build_array(jsonb_build_object(
        'id', p_mutation, 'type', 'group.rename', 'groupId', 'a0000000-0000-0000-0000-0000000000a1', 'name', p_name
    )));
$$;

-- ---------------------------------------------------------------------------
-- Alex creates a group
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

SELECT is(
    pg_temp.create_group('c0000000-0000-0000-0000-000000000001'),
    '{"applied": ["c0000000-0000-0000-0000-000000000001"], "rejected": []}'::JSONB,
    'creating a group is applied'
);

SELECT results_eq(
    $$ SELECT name, base_currency::TEXT, head_version, row_version FROM public.groups $$,
    $$ VALUES ('Japan 2027', 'JPY', 1::BIGINT, 1::BIGINT) $$,
    'the group is stored trimmed, in upper-case currency, at version 1'
);

SELECT results_eq(
    $$ SELECT user_id, display_name, role, row_version FROM public.group_members $$,
    $$ VALUES ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'Alex', 'owner', 1::BIGINT) $$,
    'the creator is the owner, in the same version'
);

SELECT is(
    pg_temp.create_group('c0000000-0000-0000-0000-000000000001')->'applied',
    '["c0000000-0000-0000-0000-000000000001"]'::JSONB,
    'pushing the same mutation again still reports it applied'
);

SELECT is(
    (SELECT head_version FROM public.groups),
    1::BIGINT,
    '... but does not apply it twice'
);

SELECT is(
    public.pull_changes('{}'::JSONB)->'group_ids',
    '["a0000000-0000-0000-0000-0000000000a1"]'::JSONB,
    'a pull lists the groups the caller belongs to'
);

SELECT is(
    jsonb_array_length(public.pull_changes('{}'::JSONB)#>'{changes,0,members}'),
    1,
    'a first pull returns every row'
);

-- ---------------------------------------------------------------------------
-- Sam is not in the group
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);

SELECT is((SELECT count(*)::INT FROM public.groups), 0, 'a non-member cannot see the group');

SELECT is(
    public.pull_changes('{}'::JSONB),
    '{"group_ids": [], "changes": []}'::JSONB,
    'a non-member pulls nothing'
);

SELECT is(
    pg_temp.rename('c0000000-0000-0000-0000-000000000002', 'Mine now'),
    '{"applied": [], "rejected": [{"id": "c0000000-0000-0000-0000-000000000002", "code": "HS403", "reason": "You are not a member of this group"}]}'::JSONB,
    'a non-member cannot rename the group'
);

SELECT throws_ok(
    $$ INSERT INTO public.groups (id, name, created_by) VALUES (gen_random_uuid(), 'Direct', 'bbbbbbbb-0000-0000-0000-000000000002') $$,
    '42501',
    NULL,
    'clients cannot write to tables directly'
);

-- ---------------------------------------------------------------------------
-- Alex renames it; pulls only return what changed past the cursor
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

SELECT is(
    pg_temp.rename('c0000000-0000-0000-0000-000000000003', 'Japan & Korea 2027')->'applied',
    '["c0000000-0000-0000-0000-000000000003"]'::JSONB,
    'the owner can rename the group'
);

SELECT is(
    public.pull_changes('{"a0000000-0000-0000-0000-0000000000a1": 1}'::JSONB)#>'{changes,0,version}',
    '2'::JSONB,
    'the pull reports the new version'
);

SELECT is(
    public.pull_changes('{"a0000000-0000-0000-0000-0000000000a1": 1}'::JSONB)#>>'{changes,0,groups,0,name}',
    'Japan & Korea 2027',
    'the pull returns the renamed group'
);

SELECT is(
    public.pull_changes('{"a0000000-0000-0000-0000-0000000000a1": 1}'::JSONB)#>'{changes,0,members}',
    '[]'::JSONB,
    '... and not the member, which did not change'
);

SELECT is(
    public.pull_changes('{"a0000000-0000-0000-0000-0000000000a1": 2}'::JSONB)->'changes',
    '[]'::JSONB,
    'an up-to-date device pulls no changes'
);

-- ---------------------------------------------------------------------------
-- One bad mutation does not block the rest of the batch
-- ---------------------------------------------------------------------------
SELECT is(
    public.push_changes(jsonb_build_array(
        jsonb_build_object('id', 'c0000000-0000-0000-0000-000000000004', 'type', 'group.explode', 'groupId', 'a0000000-0000-0000-0000-0000000000a1'),
        jsonb_build_object('id', 'c0000000-0000-0000-0000-000000000005', 'type', 'group.rename', 'groupId', 'a0000000-0000-0000-0000-0000000000a1', 'name', 'Japan 2027')
    )),
    '{"applied": ["c0000000-0000-0000-0000-000000000005"], "rejected": [{"id": "c0000000-0000-0000-0000-000000000004", "code": "HS422", "reason": "Unknown change type: group.explode"}]}'::JSONB,
    'a bad mutation is rejected and the next one still applies'
);

SELECT is(
    (public.push_changes(jsonb_build_array(
        jsonb_build_object('id', 'c0000000-0000-0000-0000-000000000006', 'type', 'group.rename', 'groupId', 'a0000000-0000-0000-0000-0000000000a1', 'name', '   ')
    ))#>'{rejected,0}') - 'reason',
    '{"id": "c0000000-0000-0000-0000-000000000006", "code": "23514"}'::JSONB,
    'a blank name is rejected by the table''s check, with its own SQLSTATE'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
