-- ============================================================================
-- pgTAP tests for guests (migrations 004–009): someone who joined through a link without an account
-- (a Supabase anonymous user, with "is_anonymous": true in the JWT). A guest can add entries, delete the
-- ones they added, rename themselves and leave; nothing else. Changes go through push_changes() and the
-- online functions as the guest. Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- ---------------------------------------------------------------------------
-- Helpers: act as a signed-in user (a guest when their auth user is anonymous)
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
CREATE FUNCTION pg_temp.join_signed_in(p_token TEXT, p_claim UUID, p_name TEXT) RETURNS UUID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.join_group(p_token, p_claim, p_name);
$$;
CREATE FUNCTION pg_temp.sqlstate_signed_in(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql SET role = 'authenticated' AS $$
BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END $$;
CREATE FUNCTION pg_temp.push(p_user UUID, p_mutation JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.push_signed_in(jsonb_build_array(jsonb_build_object('id', gen_random_uuid()) || p_mutation));
END $$;
-- 'applied', or the rejection's code.
CREATE FUNCTION pg_temp.try(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE(r#>>'{rejected,0,code}', 'applied') FROM pg_temp.push(p_user, p_mutation) r;
$$;
CREATE FUNCTION pg_temp.pull(p_user UUID, p_cursors JSONB DEFAULT '{}') RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.pull_signed_in(p_cursors);
END $$;
CREATE FUNCTION pg_temp.join(p_user UUID, p_token TEXT, p_claim UUID DEFAULT NULL, p_name TEXT DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.join_signed_in(p_token, p_claim, p_name);
END $$;
CREATE FUNCTION pg_temp.as_user(p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.sqlstate_signed_in(p_sql);
END $$;
CREATE FUNCTION pg_temp.version_of(p_entry UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.ledger_entries WHERE id = p_entry;
$$;

-- p_payer paid p_amount, split by Alex, Kim and Sam; the owed cents are worked out by hand per use.
CREATE FUNCTION pg_temp.expense(p_entry UUID, p_payer UUID, p_amount INT, p_alex INT, p_kim INT, p_sam INT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'kind', 'expense',
        'description', 'Groceries',
        'amountCents', p_amount,
        'entryDate', '2026-11-02',
        'notes', NULL,
        'items', jsonb_build_array(jsonb_build_object('amountCents', p_amount, 'paidBy', p_payer,
            'splitAmong', '["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000d1", "20000000-0000-0000-0000-0000000000b1"]'::JSONB)),
        'shares', jsonb_build_array(
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000a1', 'paidCents', CASE WHEN p_payer = '20000000-0000-0000-0000-0000000000a1' THEN p_amount ELSE 0 END, 'owedCents', p_alex),
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000d1', 'paidCents', CASE WHEN p_payer = '20000000-0000-0000-0000-0000000000d1' THEN p_amount ELSE 0 END, 'owedCents', p_kim),
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000b1', 'paidCents', CASE WHEN p_payer = '20000000-0000-0000-0000-0000000000b1' THEN p_amount ELSE 0 END, 'owedCents', p_sam)
        )
    );
$$;

-- ---------------------------------------------------------------------------
-- Alex owns group 1, Sam is a member, Kim joins as a guest.
-- Users: aaaa… Alex, bbbb… Sam, dddd… Kim (anonymous). Members 2000…<person>1; entries 3000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@guests.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@guests.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates the group');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'Alex adds Sam');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1", "displayName": "Kim"}'), 'applied', 'Alex adds Kim');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "gueststestinvitetoken0000000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'gueststestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'gueststestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000d1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim continues as a guest');
SELECT is((SELECT role FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000d1'), 'guest', 'Kim is a guest');

-- Sam paid 900 for groceries, split three ways: 300 each.
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.expense('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', 900, 300, 300, 300)), 'applied', 'Sam adds groceries');

-- ---------------------------------------------------------------------------
-- What a guest can do
-- ---------------------------------------------------------------------------
SELECT is(
    jsonb_array_length(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')#>'{changes,0,entries}'),
    1,
    'a guest pulls the group''s entries like anyone else'
);
-- Kim paid 1000, split three ways: 333.33 each, so Kim (the payer) owes 334.
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.expense('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000d1', 1000, 333, 334, 333)),
    'applied',
    'a guest adds an expense'
);
SELECT is((SELECT created_by_member_id::TEXT FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000002'), '20000000-0000-0000-0000-0000000000d1', '... recorded as added by Kim''s member row');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1", "displayName": "Kimberly"}'), 'applied', 'a guest renames themselves');

-- ---------------------------------------------------------------------------
-- What a guest can't do
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.expense('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000d1', 1200, 400, 400, 400)
        || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000002'))),
    'HS403',
    'a guest can''t edit an entry, even their own'
);
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.expense('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', 1200, 400, 400, 400)
        || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000001'))),
    'HS403',
    'a guest can''t edit someone else''s entry'
);
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000001', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000001'))),
    'HS403',
    'a guest can''t delete someone else''s entry'
);
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "entry.create", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000003", "kind": "payment", "amountCents": 300, "entryDate": "2026-11-03", "recordedVia": "settle_up",
        "shares": [{"memberId": "20000000-0000-0000-0000-0000000000d1", "paidCents": 300, "owedCents": 0}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 300}]}'),
    'HS403',
    'a guest can''t record from the settle-up tracker'
);
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', t.mutation), 'HS403', 'a guest can''t ' || t.what)
FROM (VALUES
    ('{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000009", "memberId": "20000000-0000-0000-0000-0000000000d9", "name": "Kim''s", "displayName": "Kim"}'::JSONB, 'create a group'),
    ('{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": "Kim''s Banff"}', 'rename the group'),
    ('{"type": "group.delete", "groupId": "10000000-0000-0000-0000-000000000001"}', 'delete the group'),
    ('{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}', 'complete the group'),
    ('{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-000000000091", "displayName": "Max"}', 'add people'),
    ('{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Samuel"}', 'rename someone else'),
    ('{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1"}', 'remove someone'),
    ('{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000002", "token": "gueststestinvitetoken0000000000000000000002"}', 'make an invite'),
    ('{"type": "invite.revoke", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001"}', 'revoke an invite')
) AS t(mutation, what);

SELECT is(pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd', $$ SELECT public.create_api_token('Pholio') $$), 'HS403', 'a guest can''t create an API token');
SELECT is(pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd', $$ SELECT public.list_api_tokens() $$), 'HS403', '... or list them');
SELECT is(pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd', $$ SELECT public.revoke_api_token(gen_random_uuid()) $$), 'HS403', '... or revoke one');
SELECT is((SELECT count(*)::INT FROM public.api_tokens), 0, 'no token was made');

-- ---------------------------------------------------------------------------
-- Deleting their own entry, and leaving
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000002', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000002'))),
    'applied',
    'a guest deletes an entry they added'
);
SELECT is((SELECT deleted_at IS NOT NULL FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000002'), TRUE, '... which is now deleted');

SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1"}'), 'applied', 'a guest leaves');
SELECT is(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'group_ids', '[]'::JSONB, '... and the group drops from their device');
SELECT is((SELECT deleted_at IS NULL FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001'), TRUE, 'the group carries on');

SELECT * FROM finish();
ROLLBACK;
