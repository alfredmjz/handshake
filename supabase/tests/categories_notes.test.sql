-- ============================================================================
-- pgTAP tests for bill categories and group notes (migration 010). A bill's category is one of food,
-- drinks, stay, travel, groceries, fun, or none; payments never have one. A group's note is set by
-- group.create or group.describe (checked as group.rename: the owner, not in a completed group).
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
CREATE FUNCTION pg_temp.join_signed_in(p_token TEXT, p_claim UUID, p_name TEXT) RETURNS UUID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.join_group(p_token, p_claim, p_name);
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
CREATE FUNCTION pg_temp.pull(p_user UUID, p_cursors JSONB DEFAULT '{}') RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.pull_signed_in(p_cursors);
END $$;
CREATE FUNCTION pg_temp.join(p_user UUID, p_token TEXT, p_claim UUID DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.join_signed_in(p_token, p_claim, NULL);
END $$;
CREATE FUNCTION pg_temp.version_of(p_entry UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.ledger_entries WHERE id = p_entry;
$$;
CREATE FUNCTION pg_temp.category_of(p_entry UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT category FROM public.ledger_entries WHERE id = p_entry;
$$;
CREATE FUNCTION pg_temp.note_of(p_group UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT note FROM public.groups WHERE id = p_group;
$$;
-- The pulled row of a group or an entry, as Alex sees it.
CREATE FUNCTION pg_temp.pulled_group(p_group UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT g FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->'changes') c, jsonb_array_elements(c->'groups') g
    WHERE g->>'id' = p_group::TEXT;
$$;
CREATE FUNCTION pg_temp.pulled_entry(p_entry UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT e FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->'changes') c, jsonb_array_elements(c->'entries') e
    WHERE e->>'id' = p_entry::TEXT;
$$;

-- A bill Alex paid alone and owes alone (1000 cents), in group 1, with whatever extra fields are given.
CREATE FUNCTION pg_temp.bill(p_entry UUID, p_extra JSONB DEFAULT '{}') RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'description', 'Dinner',
        'amountCents', 1000,
        'entryDate', '2026-11-02',
        'notes', NULL,
        'items', '[{"id": "i1", "amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000a1", "splitAmong": ["20000000-0000-0000-0000-0000000000a1"]}]'::JSONB,
        'shares', '[{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 1000, "owedCents": 1000, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 1000}}]'::JSONB
    ) || p_extra;
$$;
CREATE FUNCTION pg_temp.edit(p_mutation JSONB, p_base BIGINT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT p_mutation || jsonb_build_object('type', 'entry.update', 'baseVersion', p_base);
$$;
CREATE FUNCTION pg_temp.describe(p_note JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'group.describe', 'groupId', '10000000-0000-0000-0000-000000000001', 'note', p_note);
$$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner), Sam (member). Users aaaa… Alex, bbbb… Sam; members 2000…a1 Alex, …b1 Sam;
-- entries 3000…N; conflicts 4000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@categories.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@categories.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}');

-- ---------------------------------------------------------------------------
-- group.create with a note
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Japan", "displayName": "Alex", "note": "  Tokyo and Kyoto, April  "}'),
    'applied',
    'Alex creates a group with a note'
);
SELECT is(pg_temp.note_of('10000000-0000-0000-0000-000000000001'), 'Tokyo and Kyoto, April', '... stored trimmed');
SELECT is(pg_temp.pulled_group('10000000-0000-0000-0000-000000000001')->>'note', 'Tokyo and Kyoto, April', '... and pulled as note');
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pulled_group('10000000-0000-0000-0000-000000000001')) k),
    ARRAY['base_currency', 'completed_at', 'completed_by_member_id', 'created_at', 'created_by', 'deleted_at', 'id', 'join_code', 'name', 'note', 'row_version'],
    'a pulled group has exactly these keys'
);

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Two", "displayName": "Alex", "note": "   "}'), 'applied', 'a blank note is accepted');
SELECT is(pg_temp.note_of('10000000-0000-0000-0000-000000000002'), NULL, '... and stored as no note');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000a3", "name": "Three", "displayName": "Alex"}'), 'applied', 'a group without a note is accepted');
SELECT is(pg_temp.note_of('10000000-0000-0000-0000-000000000003'), NULL, '... with no note');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'group.create', 'groupId', '10000000-0000-0000-0000-000000000004', 'memberId', '20000000-0000-0000-0000-0000000000a4', 'name', 'Four', 'displayName', 'Alex', 'note', repeat('é', 121))),
    'HS422',
    'a note of 121 characters is refused'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000004", "memberId": "20000000-0000-0000-0000-0000000000a4", "name": "Four", "displayName": "Alex", "note": 5}'), 'HS422', 'a note that isn''t text is refused');

-- Sam joins group 1 as a member.
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'Alex adds Sam');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "categoriestestinvitetoken000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'categoriestestinvitetoken000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins');

-- ---------------------------------------------------------------------------
-- group.describe
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe('" Osaka too "')), 'applied', 'the owner changes the note');
SELECT results_eq(
    $$ SELECT note, row_version = head_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('Osaka too', TRUE) $$,
    '... stored trimmed, at the group''s newest version'
);
SELECT is(pg_temp.pulled_group('10000000-0000-0000-0000-000000000001')->>'note', 'Osaka too', '... and pulled');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.describe('"Sam''s trip"')), 'HS403', 'a member can''t change the note');
SELECT is(pg_temp.note_of('10000000-0000-0000-0000-000000000001'), 'Osaka too', '... which stays');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe(to_jsonb(repeat('x', 121)))), 'HS422', 'a note of 121 characters is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe(to_jsonb(repeat('x', 120)))), 'applied', 'a note of 120 characters is accepted');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe('"  "')), 'applied', 'a blank note clears it');
SELECT is(pg_temp.note_of('10000000-0000-0000-0000-000000000001'), NULL, '... to no note');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe('"Tokyo"')), 'applied', 'the owner sets it again');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe('null')), 'applied', 'a null note clears it');
SELECT is(pg_temp.note_of('10000000-0000-0000-0000-000000000001'), NULL, '... to no note');

-- ---------------------------------------------------------------------------
-- Categories on entry.create
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000001', '{"category": "food"}')), 'applied', 'a bill with category food is accepted');
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000001'), 'food', '... and stored');
SELECT is(pg_temp.pulled_entry('30000000-0000-0000-0000-000000000001')->>'category', 'food', '... and pulled as category');
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pulled_entry('30000000-0000-0000-0000-000000000001')) k),
    ARRAY['amount_cents', 'category', 'close_note', 'closed_at', 'confirmed_at', 'created_at', 'created_by_member_id', 'deleted_at', 'description', 'entry_date', 'group_id', 'id', 'items',
          'kind', 'notes', 'payer_confirmed_at', 'payment_status', 'receiver_confirmed_at', 'row_version', 'shares', 'updated_at', 'updated_by_member_id'],
    'a pulled entry has exactly these keys'
);
SELECT is(
    (SELECT snapshot->>'category' FROM public.ledger_entry_versions WHERE entry_id = '30000000-0000-0000-0000-000000000001' AND row_version = pg_temp.version_of('30000000-0000-0000-0000-000000000001')),
    'food',
    'its version snapshot keeps the category'
);

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill(('30000000-0000-0000-0000-00000000001' || n)::UUID, jsonb_build_object('category', c))),
    'applied',
    'category ' || c || ' is accepted'
)
FROM (VALUES (0, 'drinks'), (1, 'stay'), (2, 'travel'), (3, 'groceries'), (4, 'fun')) AS t(n, c);
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000014'), 'fun', '... and stored as sent');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000002')), 'applied', 'a bill without a category is accepted');
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000002'), NULL, '... with none');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000003', '{"category": null}')), 'applied', 'a bill with category null is accepted');
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000003'), NULL, '... with none');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000009', '{"category": "bar"}')), 'HS422', 'an unknown category is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000009', '{"category": "Food"}')), 'HS422', 'categories are lower case');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000009', '{"category": ""}')), 'HS422', 'an empty category is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000009', '{"category": 1}')), 'HS422', 'a category that isn''t text is refused');
SELECT is((SELECT count(*)::INT FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000009'), 0, '... and none of those was stored');

-- ---------------------------------------------------------------------------
-- Payments never have a category
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "payment.record", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000020", "fromMemberId": "20000000-0000-0000-0000-0000000000a1", "toMemberId": "20000000-0000-0000-0000-0000000000b1", "amountCents": 500, "entryDate": "2026-11-03", "notes": null, "category": "food"}'),
    'HS422',
    'a payment with a category is refused'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "payment.record", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000020", "fromMemberId": "20000000-0000-0000-0000-0000000000a1", "toMemberId": "20000000-0000-0000-0000-0000000000b1", "amountCents": 500, "entryDate": "2026-11-03", "notes": null, "category": null}'),
    'applied',
    'a payment with category null is recorded'
);
SELECT is(pg_temp.pulled_entry('30000000-0000-0000-0000-000000000020') -> 'category', 'null'::JSONB, '... and pulled with category null');
SELECT throws_ok(
    $$ UPDATE public.ledger_entries SET category = 'food' WHERE id = '30000000-0000-0000-0000-000000000020' $$,
    '23514',
    NULL,
    'the table refuses a category on a payment'
);

-- ---------------------------------------------------------------------------
-- entry.update carries the category
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.edit(pg_temp.bill('30000000-0000-0000-0000-000000000002', '{"category": "groceries"}'), pg_temp.version_of('30000000-0000-0000-0000-000000000002'))),
    'applied',
    'an edit sets a category on a bill that had none'
);
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000002'), 'groceries', '... stored');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.edit(pg_temp.bill('30000000-0000-0000-0000-000000000002'), pg_temp.version_of('30000000-0000-0000-0000-000000000002'))),
    'applied',
    'an edit without a category'
);
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000002'), NULL, '... clears it (missing means none)');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.edit(pg_temp.bill('30000000-0000-0000-0000-000000000002', '{"category": "snacks"}'), pg_temp.version_of('30000000-0000-0000-0000-000000000002'))),
    'HS422',
    'an edit with an unknown category is refused'
);

-- ---------------------------------------------------------------------------
-- Conflicts keep the category on both sides; conflict.resolve carries it
-- ---------------------------------------------------------------------------
-- The food dinner (30…01) was added at the version saved here; Alex then changes it to drinks.
CREATE TEMP TABLE saved (name TEXT PRIMARY KEY, version BIGINT NOT NULL);
INSERT INTO saved VALUES ('dinner added', pg_temp.version_of('30000000-0000-0000-0000-000000000001'));
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.edit(pg_temp.bill('30000000-0000-0000-0000-000000000001', '{"category": "drinks"}'), (SELECT version FROM saved))),
    'applied',
    'Alex changes the dinner to drinks'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.edit(pg_temp.bill('30000000-0000-0000-0000-000000000001', '{"category": "nightlife"}'), (SELECT version FROM saved))),
    'HS422',
    'a stale edit with an unknown category is refused, not stored as a conflict'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.edit(pg_temp.bill('30000000-0000-0000-0000-000000000001', '{"category": "stay"}'), (SELECT version FROM saved))
        || '{"id": "40000000-0000-0000-0000-000000000001"}'),
    'applied',
    'Sam''s stale edit to stay becomes a conflict'
);
SELECT is(pg_temp.category_of('30000000-0000-0000-0000-000000000001'), 'drinks', '... the bill stays drinks');
SELECT results_eq(
    $$ SELECT base->>'category', proposed->>'category', proposed ? 'category' FROM public.entry_conflicts WHERE id = '40000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('food', 'stay', TRUE) $$,
    '... its base (the version Sam saw) is food and its proposal stay'
);
SELECT is(
    (SELECT c->'proposed'->>'category' FROM jsonb_array_elements(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')->'changes') ch, jsonb_array_elements(ch->'conflicts') c
     WHERE c->>'id' = '40000000-0000-0000-0000-000000000001'),
    'stay',
    '... and devices pull it with the category'
);

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'conflict.resolve', 'groupId', '10000000-0000-0000-0000-000000000001',
        'conflictId', '40000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000001', 'resolution', 'merged',
        'entry', pg_temp.bill('30000000-0000-0000-0000-000000000001', '{"category": "bogus"}') - 'type' - 'groupId' - 'entryId')),
    'HS422',
    'a resolution with an unknown category is refused'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'conflict.resolve', 'groupId', '10000000-0000-0000-0000-000000000001',
        'conflictId', '40000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000001', 'resolution', 'merged',
        'entry', pg_temp.bill('30000000-0000-0000-0000-000000000001', '{"category": "travel"}') - 'type' - 'groupId' - 'entryId')),
    'applied',
    'Alex resolves it as travel'
);
SELECT results_eq(
    $$ SELECT e.category, c.resolution FROM public.ledger_entries e, public.entry_conflicts c
       WHERE e.id = '30000000-0000-0000-0000-000000000001' AND c.id = '40000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('travel', 'merged') $$,
    '... the bill is now travel and the conflict resolved'
);
SELECT is(
    (SELECT snapshot->>'category' FROM public.ledger_entry_versions WHERE entry_id = '30000000-0000-0000-0000-000000000001' AND row_version = pg_temp.version_of('30000000-0000-0000-0000-000000000001')),
    'travel',
    '... and its newest snapshot says travel'
);

-- ---------------------------------------------------------------------------
-- A completed group's note can't change
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex completes the group');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe('"Done"')), 'HS403', 'the owner can''t change the note of a completed group');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.reopen", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex reopens it');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.describe('"Done"')), 'applied', '... and then can');

SELECT * FROM finish();
ROLLBACK;
