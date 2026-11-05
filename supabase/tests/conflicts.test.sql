-- ============================================================================
-- pgTAP tests for edit conflicts (migration 006). A stale entry.update or entry.delete by someone else
-- is neither applied nor rejected: it becomes an open entry_conflicts row that every member pulls, and
-- the entry keeps its current version until someone resolves it with conflict.resolve. Your own stale
-- change is applied (last one wins). Everything goes through push_changes() and is rolled back.
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
-- The SQLSTATE a statement raises when run as a signed-in user, or 'ok'.
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
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.version_of(p_entry UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.ledger_entries WHERE id = p_entry;
$$;

-- Versions the test remembers, to start later changes from.
CREATE TEMP TABLE saved (name TEXT PRIMARY KEY, version BIGINT NOT NULL);
CREATE FUNCTION pg_temp.save(p_name TEXT, p_version BIGINT) RETURNS VOID LANGUAGE sql AS $$
    INSERT INTO saved VALUES (p_name, p_version);
$$;
CREATE FUNCTION pg_temp.saved(p_name TEXT) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT version FROM saved WHERE name = p_name;
$$;

-- A bill Alex paid, split by Alex, Jo and Sam, so everything is owed to Alex; the owed cents are worked
-- out by hand per use.
CREATE FUNCTION pg_temp.expense(p_entry UUID, p_description TEXT, p_amount INT, p_alex INT, p_jo INT, p_sam INT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'kind', 'expense',
        'description', p_description,
        'amountCents', p_amount,
        'entryDate', '2026-11-02',
        'notes', NULL,
        'items', jsonb_build_array(jsonb_build_object(
            'id', 'i1', 'amountCents', p_amount, 'paidBy', '20000000-0000-0000-0000-0000000000a1',
            'splitAmong', '["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000c1", "20000000-0000-0000-0000-0000000000b1"]'::JSONB
        )),
        'shares', jsonb_build_array(
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000a1', 'paidCents', p_amount, 'owedCents', p_alex, 'owedTo', jsonb_build_object('20000000-0000-0000-0000-0000000000a1', p_alex)),
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000c1', 'paidCents', 0, 'owedCents', p_jo, 'owedTo', jsonb_build_object('20000000-0000-0000-0000-0000000000a1', p_jo)),
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000b1', 'paidCents', 0, 'owedCents', p_sam, 'owedTo', jsonb_build_object('20000000-0000-0000-0000-0000000000a1', p_sam))
        )
    );
$$;
CREATE FUNCTION pg_temp.edit(p_mutation JSONB, p_base BIGINT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT p_mutation || jsonb_build_object('type', 'entry.update', 'baseVersion', p_base);
$$;
CREATE FUNCTION pg_temp.remove(p_entry UUID, p_base BIGINT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', p_entry, 'baseVersion', p_base);
$$;
CREATE FUNCTION pg_temp.resolve(p_conflict UUID, p_entry UUID, p_resolution TEXT, p_final JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'conflict.resolve', 'groupId', '10000000-0000-0000-0000-000000000001',
        'conflictId', p_conflict, 'entryId', p_entry, 'resolution', p_resolution, 'entry', p_final);
$$;
CREATE FUNCTION pg_temp.entry_now(p_entry UUID) RETURNS TABLE (description TEXT, amount_cents BIGINT, alex BIGINT, jo BIGINT, sam BIGINT, deleted BOOLEAN) LANGUAGE sql AS $$
    SELECT e.description, e.amount_cents,
        (SELECT owed_cents FROM public.ledger_shares WHERE entry_id = e.id AND member_id = '20000000-0000-0000-0000-0000000000a1'),
        (SELECT owed_cents FROM public.ledger_shares WHERE entry_id = e.id AND member_id = '20000000-0000-0000-0000-0000000000c1'),
        (SELECT owed_cents FROM public.ledger_shares WHERE entry_id = e.id AND member_id = '20000000-0000-0000-0000-0000000000b1'),
        e.deleted_at IS NOT NULL
    FROM public.ledger_entries e WHERE e.id = p_entry;
$$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner), Sam and Jo (members), Kim (a guest). Ids: users aaaa… Alex, bbbb… Sam,
-- cccc… Jo, dddd… Kim; members 2000…<person>1; entries 3000…N; mutations (= conflict ids) 4000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@conflicts.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@conflicts.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@conflicts.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates the group');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.add', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', p.id, 'displayName', p.name)),
    'applied',
    'Alex adds ' || p.name
)
FROM (VALUES ('20000000-0000-0000-0000-0000000000b1', 'Sam'), ('20000000-0000-0000-0000-0000000000c1', 'Jo'), ('20000000-0000-0000-0000-0000000000d1', 'Kim')) AS p(id, name);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "conflictstestinvitetoken0000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'conflictstestinvitetoken0000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins');
SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', 'conflictstestinvitetoken0000000000000000001', '20000000-0000-0000-0000-0000000000c1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Jo joins');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'conflictstestinvitetoken0000000000000000001', '20000000-0000-0000-0000-0000000000d1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim joins as a guest');

-- Alex adds the dinner: 1000 by three is 333.33 each, so Alex (the payer) owes 334, Jo and Sam 333.
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1000, 334, 333, 333)), 'applied', 'Alex adds the dinner');
SELECT pg_temp.save('dinner added', pg_temp.version_of('30000000-0000-0000-0000-000000000001'));

-- Sam edits it from that version: 1500, 500 each.
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner and drinks', 1500, 500, 500, 500), pg_temp.saved('dinner added'))),
    'applied',
    'Sam''s edit from the current version is applied'
);
SELECT pg_temp.save('sam edited', pg_temp.version_of('30000000-0000-0000-0000-000000000001'));

-- ---------------------------------------------------------------------------
-- A stale edit by someone else becomes a conflict
-- ---------------------------------------------------------------------------
-- Jo edited the version Alex added, offline, and only now syncs: 1200, 400 each.
SELECT is(
    pg_temp.push('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1200, 400, 400, 400), pg_temp.saved('dinner added'))
        || '{"id": "40000000-0000-0000-0000-000000000001"}'),
    '{"applied": ["40000000-0000-0000-0000-000000000001"], "rejected": []}'::JSONB,
    'Jo''s stale edit is not rejected: it counts as applied, so it leaves Jo''s outbox'
);

SELECT results_eq(
    $$ SELECT * FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('Dinner and drinks', 1500::BIGINT, 500::BIGINT, 500::BIGINT, 500::BIGINT, FALSE) $$,
    '... it is not applied either: the entry and its shares stay as Sam left them, so balances use them'
);
SELECT is(pg_temp.version_of('30000000-0000-0000-0000-000000000001'), pg_temp.saved('sam edited'), '... and the entry keeps its version');

SELECT results_eq(
    $$ SELECT entry_id::TEXT, base_version, proposed_by_member_id::TEXT, resolved_at, resolved_by_member_id, resolution, row_version = (SELECT head_version FROM public.groups WHERE id = group_id)
       FROM public.entry_conflicts $$,
    $$ VALUES ('30000000-0000-0000-0000-000000000001', pg_temp.saved('dinner added'), '20000000-0000-0000-0000-0000000000c1', NULL::TIMESTAMPTZ, NULL::UUID, NULL::TEXT, TRUE) $$,
    'one open conflict, named after Jo''s mutation, from the version Jo started from, stamped with the next version'
);
SELECT results_eq(
    $$ SELECT base->>'description', (base->>'amountCents')::INT, (base->>'rowVersion')::BIGINT, base->>'updatedByMemberId', base->'shares'->0->>'owedCents',
              proposed->>'description', (proposed->>'amountCents')::INT, proposed->'shares',
              proposed ? 'rowVersion', proposed ? 'updatedByMemberId', proposed->'deletedAt'
       FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('Dinner', 1000, pg_temp.saved('dinner added'), '20000000-0000-0000-0000-0000000000a1', '334',
               'Dinner', 1200,
               '[{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 1200, "owedCents": 400, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 400}},
                 {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 400, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 400}},
                 {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 400, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 400}}]'::JSONB,
               FALSE, FALSE, 'null'::JSONB) $$,
    'it holds the base version (Alex''s dinner, Alex owing 334) and Jo''s proposed version (1200, shares by member id, no version fields)'
);

SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.saved('sam edited')))#>'{changes,0,conflicts,0}') k),
    ARRAY['base', 'base_version', 'created_at', 'entry_id', 'group_id', 'id', 'proposed', 'proposed_by_member_id', 'resolution', 'resolved_at', 'resolved_by_member_id', 'row_version'],
    'Alex pulls the conflict, with exactly the keys wire.ts reads'
);
SELECT results_eq(
    $$ SELECT jsonb_array_length(c->'conflicts'), jsonb_array_length(c->'entries')
       FROM jsonb_array_elements(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.saved('sam edited')))->'changes') c $$,
    $$ VALUES (1, 0) $$,
    'every member pulls it, the guest too; the entry itself did not change, so it isn''t sent again'
);

-- ---------------------------------------------------------------------------
-- Your own stale edit is applied: the same person on two devices, last one wins
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner and drinks (tip)', 1500, 500, 500, 500), pg_temp.saved('dinner added'))),
    'applied',
    'Sam, the last to change it, edits from the old version on a second device'
);
SELECT results_eq(
    $$ SELECT description, (SELECT count(*)::INT FROM public.entry_conflicts) FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('Dinner and drinks (tip)', 1) $$,
    '... and it is applied, with no new conflict'
);
SELECT pg_temp.save('sam edited again', pg_temp.version_of('30000000-0000-0000-0000-000000000001'));

-- ---------------------------------------------------------------------------
-- Another stale edit while one is open adds a second conflict; a stale delete is a conflict too
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1500, 500, 500, 500), pg_temp.saved('sam edited'))
        || '{"id": "40000000-0000-0000-0000-000000000002"}'),
    'applied',
    'Alex''s stale edit is accepted'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.remove('30000000-0000-0000-0000-000000000001', pg_temp.saved('sam edited')) || '{"id": "40000000-0000-0000-0000-000000000003"}'),
    'applied',
    'Alex''s stale delete is accepted'
);
SELECT results_eq(
    $$ SELECT id::TEXT, base_version, base IS NOT NULL, proposed IS NULL FROM public.entry_conflicts WHERE resolved_at IS NULL ORDER BY id $$,
    $$ VALUES ('40000000-0000-0000-0000-000000000001', pg_temp.saved('dinner added'), TRUE, FALSE),
              ('40000000-0000-0000-0000-000000000002', pg_temp.saved('sam edited'), TRUE, FALSE),
              ('40000000-0000-0000-0000-000000000003', pg_temp.saved('sam edited'), TRUE, TRUE) $$,
    'three open conflicts on the dinner; the delete''s proposed version is NULL'
);
SELECT is((SELECT deleted_at FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000001'), NULL, 'the stale delete didn''t delete it');

-- ---------------------------------------------------------------------------
-- Resolving: owner or member; the first one wins
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.resolve('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'took_proposed',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1200, 400, 400, 400))),
    'HS403',
    'a guest can''t resolve'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.resolve('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'took_proposed',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1200, 401, 400, 399))),
    'HS422',
    'a final version whose shares don''t match its items is refused'
);
SELECT is((SELECT resolved_at FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000001'), NULL, '... and the conflict stays open');
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.resolve('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'picked_one',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1200, 400, 400, 400))),
    'HS422',
    'the resolution must be kept_current, took_proposed or merged'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.resolve('40000000-0000-0000-0000-000000000099', '30000000-0000-0000-0000-000000000001', 'kept_current', '{"deleted": true}')),
    'HS404',
    'an unknown conflict is not found'
);

-- took_proposed: Sam takes Jo's version.
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.resolve('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'took_proposed',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1200, 400, 400, 400) - 'kind')),
    'applied',
    'Sam resolves the first conflict by taking Jo''s version (kind may be left out)'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('Dinner', 1200::BIGINT, 400::BIGINT, 400::BIGINT, 400::BIGINT, FALSE) $$,
    'took_proposed: the entry and its shares are Jo''s version'
);
SELECT results_eq(
    $$ SELECT c.resolution, c.resolved_by_member_id::TEXT, c.resolved_at IS NOT NULL, c.row_version = e.row_version, e.row_version = (SELECT head_version FROM public.groups WHERE id = e.group_id), e.updated_by_member_id::TEXT
       FROM public.entry_conflicts c JOIN public.ledger_entries e ON e.id = c.entry_id WHERE c.id = '40000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('took_proposed', '20000000-0000-0000-0000-0000000000b1', TRUE, TRUE, TRUE, '20000000-0000-0000-0000-0000000000b1') $$,
    '... the conflict is closed by Sam, and it and the entry share the new version'
);
SELECT is(
    (pg_temp.push('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.resolve('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'kept_current',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1500, 500, 500, 500)))->'rejected'->0) - 'id',
    '{"code": "HS409", "reason": "Sam already resolved this"}'::JSONB,
    'a second resolver gets HS409, naming who resolved it'
);
SELECT is((SELECT amount_cents FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000001'), 1200::BIGINT, '... and the first resolution stands');

-- kept_current: Alex keeps the current version (Jo's, now) over Alex's own stale edit.
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.resolve('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'kept_current',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner', 1200, 400, 400, 400))),
    'applied',
    'Alex resolves the second by keeping the current version'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('Dinner', 1200::BIGINT, 400::BIGINT, 400::BIGINT, 400::BIGINT, FALSE) $$,
    'kept_current: the entry is unchanged'
);

-- merged: Jo writes a version of their own for the stale delete: 900, 300 each.
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.resolve('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'merged',
        pg_temp.expense('30000000-0000-0000-0000-000000000001', 'Dinner (merged)', 900, 300, 300, 300))),
    'applied',
    'Jo resolves the stale delete with a merged version'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('Dinner (merged)', 900::BIGINT, 300::BIGINT, 300::BIGINT, 300::BIGINT, FALSE) $$,
    'merged: the entry and its shares are the final version'
);
SELECT results_eq(
    $$ SELECT id::TEXT, resolution FROM public.entry_conflicts ORDER BY id $$,
    $$ VALUES ('40000000-0000-0000-0000-000000000001', 'took_proposed'), ('40000000-0000-0000-0000-000000000002', 'kept_current'), ('40000000-0000-0000-0000-000000000003', 'merged') $$,
    'all three conflicts are closed with their resolution'
);

-- ---------------------------------------------------------------------------
-- An edit against a deleted entry is a conflict; resolving can restore it or keep it deleted
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('30000000-0000-0000-0000-000000000002', 'Taxi', 600, 200, 200, 200)), 'applied', 'Alex adds a taxi');
SELECT pg_temp.save('taxi added', pg_temp.version_of('30000000-0000-0000-0000-000000000002'));
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.remove('30000000-0000-0000-0000-000000000002', pg_temp.saved('taxi added'))), 'applied', 'Sam deletes it');
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000002', 'Taxi home', 900, 300, 300, 300), pg_temp.saved('taxi added'))
        || '{"id": "40000000-0000-0000-0000-000000000004"}'),
    'applied',
    'Jo, offline, edited the taxi before it was deleted'
);
SELECT results_eq(
    $$ SELECT deleted, (SELECT proposed->>'description' FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000004'),
              (SELECT base->>'deletedAt' FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000004')
       FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000002') $$,
    $$ VALUES (TRUE, 'Taxi home', NULL::TEXT) $$,
    'that is a conflict: the taxi stays deleted, with Jo''s edit proposed against the version Jo saw'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.resolve('40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000002', 'took_proposed',
        pg_temp.expense('30000000-0000-0000-0000-000000000002', 'Taxi home', 900, 300, 300, 300))),
    'applied',
    'Alex picks "Restore this version"'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000002') $$,
    $$ VALUES ('Taxi home', 900::BIGINT, 300::BIGINT, 300::BIGINT, 300::BIGINT, FALSE) $$,
    'the taxi is back, as Jo had it'
);

SELECT pg_temp.save('taxi restored', pg_temp.version_of('30000000-0000-0000-0000-000000000002'));
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.remove('30000000-0000-0000-0000-000000000002', pg_temp.saved('taxi restored'))), 'applied', 'Sam deletes the taxi again');
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000002', 'Taxi there and back', 1200, 400, 400, 400), pg_temp.saved('taxi restored'))
        || '{"id": "40000000-0000-0000-0000-000000000005"}'),
    'applied',
    '... and Jo''s stale edit meets it again'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.resolve('40000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000002', 'kept_current', '{"deleted": true}')),
    'applied',
    'Sam picks "Keep it deleted"'
);
SELECT results_eq(
    $$ SELECT deleted, (SELECT resolution FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000005') FROM pg_temp.entry_now('30000000-0000-0000-0000-000000000002') $$,
    $$ VALUES (TRUE, 'kept_current') $$,
    'the taxi stays deleted and the conflict is closed'
);
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.remove('30000000-0000-0000-0000-000000000002', pg_temp.saved('taxi added'))),
    'applied',
    'a stale delete of an entry already deleted is accepted'
);
SELECT is((SELECT count(*)::INT FROM public.entry_conflicts WHERE entry_id = '30000000-0000-0000-0000-000000000002'), 2, '... and opens no conflict: there is nothing to disagree about');

-- ---------------------------------------------------------------------------
-- Versions: the newest 20 are kept; a base older than that comes through as NULL
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('30000000-0000-0000-0000-000000000003', 'Groceries', 3000, 1000, 1000, 1000)), 'applied', 'Alex adds groceries');
SELECT pg_temp.save('groceries added', pg_temp.version_of('30000000-0000-0000-0000-000000000003'));
SELECT is(
    (SELECT count(*)::INT FROM generate_series(1, 21) n
     WHERE pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.edit(
        pg_temp.expense('30000000-0000-0000-0000-000000000003', 'Groceries ' || n, 3000, 1000, 1000, 1000), pg_temp.version_of('30000000-0000-0000-0000-000000000003'))) = 'applied'),
    21,
    'Alex edits the groceries 21 times'
);
SELECT results_eq(
    $$ SELECT count(*)::INT, min(row_version) > pg_temp.saved('groceries added') FROM public.ledger_entry_versions WHERE entry_id = '30000000-0000-0000-0000-000000000003' $$,
    $$ VALUES (20, TRUE) $$,
    'only its newest 20 versions are kept: the first two are gone'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.edit(pg_temp.expense('30000000-0000-0000-0000-000000000003', 'Food', 3000, 1000, 1000, 1000), pg_temp.saved('groceries added'))
        || '{"id": "40000000-0000-0000-0000-000000000006"}'),
    'applied',
    'Sam''s edit from the very first version arrives'
);
SELECT results_eq(
    $$ SELECT base_version, base, proposed->>'description' FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000006' $$,
    $$ VALUES (pg_temp.saved('groceries added'), NULL::JSONB, 'Food') $$,
    'its conflict has base NULL, because that version is no longer kept'
);

SELECT is(
    pg_temp.sqlstate_signed_in('SELECT count(*) FROM public.ledger_entry_versions'),
    '42501',
    'devices can''t read the version history'
);

SELECT * FROM finish();
ROLLBACK;
