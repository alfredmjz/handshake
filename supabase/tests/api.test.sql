-- ============================================================================
-- pgTAP tests for API v1's database half (migration 009): the token functions, called as a signed-in
-- user, and api.v1_*, called as handshake_api with a token's hash, the way the Vercel function calls
-- them. Covers hashing, HS401 and HS429, owner-only data with hand-worked numbers, the entries feed
-- cursor, and how little handshake_api can reach. The shapes and paging are also checked against the
-- in-memory store by the ApiStore contract suite (chat 3). Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- postgres created handshake_api, so it may grant itself the right to act as it (for this test only).
GRANT handshake_api TO postgres WITH INHERIT FALSE, SET TRUE;

-- ---------------------------------------------------------------------------
-- Helpers: act as a signed-in user, or as the API function (handshake_api)
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
CREATE FUNCTION pg_temp.create_token_signed_in(p_name TEXT) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.create_api_token(p_name);
$$;
CREATE FUNCTION pg_temp.list_tokens_signed_in() RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.list_api_tokens();
$$;
CREATE FUNCTION pg_temp.revoke_token_signed_in(p_id UUID) RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.revoke_api_token(p_id);
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
CREATE FUNCTION pg_temp.create_token(p_user UUID, p_name TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.create_token_signed_in(p_name);
END $$;
CREATE FUNCTION pg_temp.list_tokens(p_user UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.list_tokens_signed_in();
END $$;
CREATE FUNCTION pg_temp.revoke_token(p_user UUID, p_id UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    PERFORM pg_temp.revoke_token_signed_in(p_id);
END $$;

CREATE FUNCTION pg_temp.v1_me(p_hash TEXT) RETURNS JSONB LANGUAGE sql SET role = 'handshake_api' AS $$
    SELECT api.v1_me(p_hash);
$$;
CREATE FUNCTION pg_temp.v1_groups(p_hash TEXT) RETURNS JSONB LANGUAGE sql SET role = 'handshake_api' AS $$
    SELECT api.v1_groups(p_hash);
$$;
CREATE FUNCTION pg_temp.v1_group(p_hash TEXT, p_group UUID) RETURNS JSONB LANGUAGE sql SET role = 'handshake_api' AS $$
    SELECT api.v1_group(p_hash, p_group);
$$;
CREATE FUNCTION pg_temp.v1_entries(p_hash TEXT, p_group UUID, p_cursor JSONB, p_limit INT) RETURNS JSONB LANGUAGE sql SET role = 'handshake_api' AS $$
    SELECT api.v1_entries(p_hash, p_group, p_cursor, p_limit);
$$;
-- The SQLSTATE (and DETAIL, if any) a statement raises when run as handshake_api, or 'ok'.
CREATE FUNCTION pg_temp.sqlstate_as_api(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql SET role = 'handshake_api' AS $$
DECLARE
    v_detail TEXT;
BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    RETURN SQLSTATE || CASE WHEN v_detail <> '' THEN ' ' || v_detail ELSE '' END;
END $$;

-- What the handler sends: the hex SHA-256 of the whole token.
CREATE FUNCTION pg_temp.hash(p_token TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;
CREATE TEMP TABLE tokens (name TEXT PRIMARY KEY, id UUID NOT NULL, token TEXT NOT NULL);
CREATE FUNCTION pg_temp.keep(p_name TEXT, p_created JSONB) RETURNS JSONB LANGUAGE sql AS $$
    INSERT INTO tokens VALUES (p_name, (p_created->>'id')::UUID, p_created->>'token') RETURNING p_created;
$$;
CREATE FUNCTION pg_temp.token_hash(p_name TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT pg_temp.hash(token) FROM tokens WHERE name = p_name;
$$;
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.version_of(p_entry UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.ledger_entries WHERE id = p_entry;
$$;
-- An expense in p_group; p_shares are { memberId: [paid, owed] }, worked out by hand per use.
CREATE FUNCTION pg_temp.expense(p_group UUID, p_entry UUID, p_description TEXT, p_amount INT, p_payer UUID, p_shares JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create', 'groupId', p_group, 'entryId', p_entry, 'kind', 'expense', 'description', p_description,
        'amountCents', p_amount, 'entryDate', '2026-11-02', 'notes', NULL,
        'items', jsonb_build_array(jsonb_build_object('amountCents', p_amount, 'paidBy', p_payer,
            'splitAmong', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(p_shares) k WHERE (p_shares->k->>1)::INT > 0))),
        'shares', (SELECT jsonb_agg(jsonb_build_object('memberId', k, 'paidCents', (p_shares->k->>0)::INT, 'owedCents', (p_shares->k->>1)::INT)) FROM jsonb_object_keys(p_shares) k)
    );
$$;

-- ---------------------------------------------------------------------------
-- Banff (group 1) is Alex's, with Sam and Jo, and Pat added by name. Jasper (group 2) is Lee's; Sam
-- isn't in it. Canmore (group 3) is Alex's; Sam joins it later. Users: aaaa… Alex, bbbb… Sam,
-- cccc… Jo, dddd… Kim (anonymous), eeee… Lee. Members 2000…<person><group>; entries 3000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@api.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@api.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@api.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'lee@api.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Lee"}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates Banff');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.add', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', p.id, 'displayName', p.name)),
    'applied',
    'Alex adds ' || p.name
)
FROM (VALUES ('20000000-0000-0000-0000-0000000000b1', 'Sam'), ('20000000-0000-0000-0000-0000000000c1', 'Jo'), ('20000000-0000-0000-0000-0000000000f1', 'Pat')) AS p(id, name);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "apitestinvitetoken0000000000000000000000001"}'), 'applied', 'Alex makes a link to Banff');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'apitestinvitetoken0000000000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins Banff');
SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', 'apitestinvitetoken0000000000000000000000001', '20000000-0000-0000-0000-0000000000c1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Jo joins Banff');
SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000e2", "name": "Jasper", "displayName": "Lee"}'), 'applied', 'Lee creates Jasper');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000a3", "name": "Canmore", "displayName": "Alex"}'), 'applied', 'Alex creates Canmore');

-- The $10 dinner: Sam paid 1000 split by Alex, Jo and Sam → Alex 333, Jo 333, Sam 334 (Sam covers the cent).
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.expense('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Dinner', 1000, '20000000-0000-0000-0000-0000000000b1',
        '{"20000000-0000-0000-0000-0000000000a1": [0, 333], "20000000-0000-0000-0000-0000000000b1": [1000, 334], "20000000-0000-0000-0000-0000000000c1": [0, 333]}')),
    'applied',
    'Sam adds the $10 dinner to Banff'
);
-- Lee paid 800 in Jasper, all Lee's.
SELECT is(
    pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.expense('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000009', 'Hotel', 800, '20000000-0000-0000-0000-0000000000e2',
        '{"20000000-0000-0000-0000-0000000000e2": [800, 800]}')),
    'applied',
    'Lee adds a hotel to Jasper'
);

-- ---------------------------------------------------------------------------
-- Tokens: shown once, stored only as a hash
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.keep('sam', pg_temp.create_token('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '  Pholio '))) k),
    ARRAY['createdAt', 'id', 'name', 'token'],
    'Sam makes a token for Pholio and gets back exactly id, token, name and createdAt'
);
SELECT matches((SELECT token FROM tokens WHERE name = 'sam'), '^hsk_[A-Za-z0-9_-]{43}$', 'the token is hsk_ and 43 base64url characters');
SELECT results_eq(
    $$ SELECT t.name, t.scope, t.token_hash, t.last_used_at, t.revoked_at, t.rate_window_count FROM public.api_tokens t WHERE t.id = (SELECT id FROM tokens WHERE name = 'sam') $$,
    $$ VALUES ('Pholio', 'read', pg_temp.token_hash('sam'), NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 0) $$,
    'the server keeps the name (trimmed), the read scope and the hex SHA-256 of the token'
);
SELECT is(
    (SELECT count(*)::INT FROM public.api_tokens t WHERE to_jsonb(t)::TEXT LIKE '%' || substr((SELECT token FROM tokens WHERE name = 'sam'), 5) || '%'),
    0,
    '... and never the token itself'
);
SELECT pg_temp.keep('sam 2', pg_temp.create_token('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Spreadsheet'));
SELECT isnt((SELECT token FROM tokens WHERE name = 'sam 2'), (SELECT token FROM tokens WHERE name = 'sam'), 'every token is different');

SELECT is(pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $$ SELECT public.create_api_token('   ') $$), 'HS422', 'a token needs a name');
SELECT is(pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', format('SELECT public.create_api_token(%L)', repeat('x', 61))), 'HS422', '... of at most 60 characters');
SELECT is(pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd', $$ SELECT public.create_api_token('Pholio') $$), 'HS403', 'a guest (anonymous) can''t make one');

SELECT is(
    (SELECT count(*)::INT FROM generate_series(1, 10) n WHERE pg_temp.create_token('cccccccc-cccc-cccc-cccc-cccccccccccc', 'App ' || n) ? 'token'),
    10,
    'Jo makes 10 tokens'
);
SELECT is(pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc', $$ SELECT public.create_api_token('App 11') $$), 'HS422', 'an 11th live token is refused');
SELECT lives_ok(
    $$ SELECT pg_temp.revoke_token('cccccccc-cccc-cccc-cccc-cccccccccccc', (SELECT id FROM public.api_tokens WHERE name = 'App 1')) $$,
    'Jo revokes one'
);
SELECT is(pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc', $$ SELECT public.create_api_token('App 11') $$), 'ok', '... and can make another');

-- Sam's second token was made a minute "later", so the list order is clear.
UPDATE public.api_tokens SET created_at = created_at - INTERVAL '1 minute' WHERE id = (SELECT id FROM tokens WHERE name = 'sam');
SELECT is(
    pg_temp.list_tokens('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    jsonb_build_array(
        (SELECT jsonb_build_object('id', id, 'name', name, 'scope', 'read', 'createdAt', created_at, 'lastUsedAt', NULL) FROM public.api_tokens WHERE id = (SELECT id FROM tokens WHERE name = 'sam 2')),
        (SELECT jsonb_build_object('id', id, 'name', name, 'scope', 'read', 'createdAt', created_at, 'lastUsedAt', NULL) FROM public.api_tokens WHERE id = (SELECT id FROM tokens WHERE name = 'sam'))
    ),
    'Sam lists their live tokens, newest first, with exactly id, name, scope, createdAt and lastUsedAt'
);
SELECT lives_ok($$ SELECT pg_temp.revoke_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (SELECT id FROM tokens WHERE name = 'sam 2')) $$, 'Alex tries to revoke Sam''s token');
SELECT is(jsonb_array_length(pg_temp.list_tokens('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')), 2, '... which does nothing: it isn''t Alex''s');
SELECT lives_ok($$ SELECT pg_temp.revoke_token('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', (SELECT id FROM tokens WHERE name = 'sam 2')) $$, 'Sam revokes the second token');
SELECT lives_ok($$ SELECT pg_temp.revoke_token('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', (SELECT id FROM tokens WHERE name = 'sam 2')) $$, '... twice, which is fine');
SELECT is(pg_temp.list_tokens('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')->0->>'name', 'Pholio', 'the list shows only the live one');

-- ---------------------------------------------------------------------------
-- Authenticating: the hash of a live token, or HS401
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.v1_me(pg_temp.token_hash('sam')),
    '{"userId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "displayName": "Sam"}'::JSONB,
    'v1_me with Sam''s token''s hash returns Sam'
);
SELECT results_eq(
    $$ SELECT last_used_at = NOW(), rate_window_start = NOW(), rate_window_count FROM public.api_tokens WHERE id = (SELECT id FROM tokens WHERE name = 'sam') $$,
    $$ VALUES (TRUE, TRUE, 1) $$,
    'the call is counted in a new one-minute window and stamps last_used_at'
);
SELECT is(pg_temp.sqlstate_as_api(format('SELECT api.v1_me(%L)', pg_temp.token_hash('sam 2'))), 'HS401', 'a revoked token gets HS401');
SELECT is(pg_temp.sqlstate_as_api(format('SELECT api.v1_groups(%L)', pg_temp.hash('hsk_' || repeat('A', 43)))), 'HS401', 'an unknown token gets HS401');
SELECT is(pg_temp.sqlstate_as_api(format('SELECT api.v1_me(%L)', (SELECT token FROM tokens WHERE name = 'sam'))), 'HS401', 'the raw token instead of its hash gets HS401');

-- ---------------------------------------------------------------------------
-- Only the token owner's groups and shares
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.v1_groups(pg_temp.token_hash('sam')) #- '{0,updatedAt}',
    '[{"id": "10000000-0000-0000-0000-000000000001", "name": "Banff", "role": "member", "memberId": "20000000-0000-0000-0000-0000000000b1",
       "paidCents": 1000, "owedCents": 334, "completedAt": null}]'::JSONB,
    'v1_groups for Sam: only Banff (not Jasper or Canmore), where Sam paid 1000 and owes 334'
);
SELECT is(
    (pg_temp.v1_groups(pg_temp.token_hash('sam'))->0->>'updatedAt')::TIMESTAMPTZ,
    (SELECT GREATEST(max(e.updated_at), max(gm.updated_at), max(g.updated_at)) FROM public.groups g
     JOIN public.group_members gm ON gm.group_id = g.id JOIN public.ledger_entries e ON e.group_id = g.id WHERE g.id = '10000000-0000-0000-0000-000000000001'),
    '... updatedAt is the latest change to the group, its people or its entries'
);
SELECT pg_temp.keep('alex', pg_temp.create_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Pholio'));
SELECT is(
    (SELECT jsonb_agg(g - 'updatedAt') FROM jsonb_array_elements(pg_temp.v1_groups(pg_temp.token_hash('alex'))) g),
    '[{"id": "10000000-0000-0000-0000-000000000001", "name": "Banff", "role": "owner", "memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333, "completedAt": null},
      {"id": "10000000-0000-0000-0000-000000000003", "name": "Canmore", "role": "owner", "memberId": "20000000-0000-0000-0000-0000000000a3", "paidCents": 0, "owedCents": 0, "completedAt": null}]'::JSONB,
    'v1_groups for Alex: Banff (owes 333) and Canmore, by name'
);
SELECT is(
    pg_temp.v1_group(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000001') - 'updatedAt',
    '{"id": "10000000-0000-0000-0000-000000000001", "name": "Banff", "role": "member", "memberId": "20000000-0000-0000-0000-0000000000b1",
      "paidCents": 1000, "owedCents": 334, "completedAt": null,
      "members": [
        {"memberId": "20000000-0000-0000-0000-0000000000a1", "displayName": "Alex", "active": true, "paidCents": 0, "owedCents": 333},
        {"memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo", "active": true, "paidCents": 0, "owedCents": 333},
        {"memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat", "active": true, "paidCents": 0, "owedCents": 0},
        {"memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam", "active": true, "paidCents": 1000, "owedCents": 334}]}'::JSONB,
    'v1_group for Banff: Sam''s totals plus every member''s, by name, so the handler can work out settle-up (Alex → Sam 333, Jo → Sam 333)'
);
SELECT is(pg_temp.v1_group(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000002'), NULL, 'v1_group for a group Sam isn''t in returns NULL (the store reports HS404)');
SELECT is(pg_temp.v1_group(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000099'), NULL, '... and so does an unknown group');
SELECT is((SELECT rate_window_count FROM public.api_tokens WHERE id = (SELECT id FROM tokens WHERE name = 'sam')), 6, 'Sam''s token has made 6 calls, the two not-found ones included');

-- Members who left keep their totals, marked inactive; deleted entries don't count.
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.expense('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005', 'Snacks', 400, '20000000-0000-0000-0000-0000000000c1',
        '{"20000000-0000-0000-0000-0000000000b1": [0, 200], "20000000-0000-0000-0000-0000000000c1": [400, 200]}')),
    'applied',
    'Jo adds snacks: Jo paid 400, Jo and Sam 200 each'
);
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000005', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000005'))), 'applied', '... then deletes them');
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000c1"}'), 'applied', '... and leaves Banff');
SELECT is(
    pg_temp.v1_group(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000001')->'members'->1,
    '{"memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo", "active": false, "paidCents": 0, "owedCents": 333}'::JSONB,
    'Jo is still listed, inactive, with the dinner share and not the deleted snacks'
);
SELECT is((pg_temp.v1_groups(pg_temp.token_hash('sam'))->0->>'owedCents')::INT, 334, 'Sam''s total skips the deleted snacks too');

-- ---------------------------------------------------------------------------
-- 60 calls a minute per token; refused calls don't count
-- ---------------------------------------------------------------------------
SELECT pg_temp.keep('lee', pg_temp.create_token('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Pholio'));
SELECT is((SELECT count(*)::INT FROM generate_series(1, 60) n WHERE pg_temp.v1_me(pg_temp.token_hash('lee')) ? 'userId'), 60, 'Lee''s token makes 60 calls in a minute');
SELECT is(pg_temp.sqlstate_as_api(format('SELECT api.v1_groups(%L)', pg_temp.token_hash('lee'))), 'HS429 60', 'the 61st gets HS429, with 60 seconds to wait in DETAIL');
SELECT is((SELECT rate_window_count FROM public.api_tokens WHERE id = (SELECT id FROM tokens WHERE name = 'lee')), 60, 'the refused call didn''t count');
SELECT is(pg_temp.v1_me(pg_temp.token_hash('sam'))->>'displayName', 'Sam', 'another token isn''t limited by Lee''s');

-- A minute later the window starts again.
UPDATE public.api_tokens SET rate_window_start = rate_window_start - INTERVAL '61 seconds' WHERE id = (SELECT id FROM tokens WHERE name = 'lee');
SELECT is(pg_temp.v1_me(pg_temp.token_hash('lee'))->>'displayName', 'Lee', 'after the minute, Lee''s token works again');
SELECT is((SELECT rate_window_count FROM public.api_tokens WHERE id = (SELECT id FROM tokens WHERE name = 'lee')), 1, '... in a new window');

-- ---------------------------------------------------------------------------
-- The entries feed
-- ---------------------------------------------------------------------------
-- Banff now has the dinner (Sam in it) and the deleted snacks. Add a taxi Sam is in and a lunch Sam isn't:
-- taxi: Alex paid 600, Alex and Sam 300 each; lunch: Alex paid 300, all Alex's.
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Taxi', 600, '20000000-0000-0000-0000-0000000000a1',
        '{"20000000-0000-0000-0000-0000000000a1": [600, 300], "20000000-0000-0000-0000-0000000000b1": [0, 300]}')),
    'applied', 'Alex adds a taxi'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'Lunch', 300, '20000000-0000-0000-0000-0000000000a1',
        '{"20000000-0000-0000-0000-0000000000a1": [300, 300]}')),
    'applied', 'Alex adds a lunch only Alex shares'
);

SELECT results_eq(
    $$ SELECT e->>'id', e->>'description', (e->>'involved')::BOOLEAN, (e->>'paidCents')::INT, (e->>'owedCents')::INT, e->>'deletedAt' IS NOT NULL
       FROM jsonb_array_elements(pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, '{}', 2)->'entries') e $$,
    $$ VALUES ('30000000-0000-0000-0000-000000000001', 'Dinner', TRUE, 1000, 334, FALSE), ('30000000-0000-0000-0000-000000000005', 'Snacks', TRUE, 0, 200, TRUE) $$,
    'the first page of 2: the dinner (Sam paid 1000, owes 334), then the deleted snacks, in version order'
);
SELECT is(
    pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, '{}', 2) - 'entries',
    jsonb_build_object('cursor', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.version_of('30000000-0000-0000-0000-000000000005')), 'hasMore', TRUE, 'removedGroupIds', '[]'::JSONB),
    '... its cursor stops at the snacks'' version, and there is more'
);
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, '{}', 1)->'entries'->0) k),
    ARRAY['createdAt', 'deletedAt', 'description', 'entryDate', 'groupId', 'hasConflict', 'id', 'involved', 'kind', 'owedCents', 'paidCents', 'totalCents', 'updatedAt'],
    'a feed entry has exactly these keys (the handler adds netCents)'
);
SELECT is(
    (pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, '{}', 1)->'entries'->0) - 'createdAt' - 'updatedAt',
    '{"id": "30000000-0000-0000-0000-000000000001", "groupId": "10000000-0000-0000-0000-000000000001", "kind": "expense", "description": "Dinner",
      "entryDate": "2026-11-02", "totalCents": 1000, "involved": true, "paidCents": 1000, "owedCents": 334, "hasConflict": false, "deletedAt": null}'::JSONB,
    'the dinner as Sam''s feed shows it'
);

SELECT results_eq(
    $$ SELECT e->>'description', (e->>'involved')::BOOLEAN, (e->>'paidCents')::INT, (e->>'owedCents')::INT
       FROM jsonb_array_elements(pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.version_of('30000000-0000-0000-0000-000000000005')), 2)->'entries') e $$,
    $$ VALUES ('Taxi', TRUE, 0, 300), ('Lunch', FALSE, 0, 0) $$,
    'the next page: the taxi (Sam owes 300) and the lunch, which Sam isn''t in (zeros)'
);
SELECT is(
    pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.version_of('30000000-0000-0000-0000-000000000005')), 2) - 'entries',
    jsonb_build_object('cursor', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001')), 'hasMore', FALSE, 'removedGroupIds', '[]'::JSONB),
    '... after which Banff is fully read: its cursor value is its head version'
);
SELECT is(
    pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001')), 100)->'entries',
    '[]'::JSONB,
    'an up-to-date cursor gets no entries'
);

-- A newly joined group arrives with its whole history: Canmore's parking (Alex paid 200, Alex and Sam 100 each).
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000b3", "displayName": "Sam"}'), 'applied', 'Alex adds Sam to Canmore');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('10000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Parking', 200, '20000000-0000-0000-0000-0000000000a3',
        '{"20000000-0000-0000-0000-0000000000a3": [200, 100], "20000000-0000-0000-0000-0000000000b3": [0, 100]}')),
    'applied', 'Alex adds parking to Canmore, before Sam has joined'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000003", "inviteId": "50000000-0000-0000-0000-000000000003", "token": "apitestinvitetoken0000000000000000000000003"}'), 'applied', 'Alex makes a link to Canmore');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'apitestinvitetoken0000000000000000000000003', '20000000-0000-0000-0000-0000000000b3'), '10000000-0000-0000-0000-000000000003'::UUID, 'Sam joins Canmore');
SELECT is(
    pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001')), 100) #- '{entries,0,createdAt}' #- '{entries,0,updatedAt}',
    jsonb_build_object(
        'entries', '[{"id": "30000000-0000-0000-0000-000000000004", "groupId": "10000000-0000-0000-0000-000000000003", "kind": "expense", "description": "Parking", "entryDate": "2026-11-02",
                      "totalCents": 200, "involved": true, "paidCents": 0, "owedCents": 100, "hasConflict": false, "deletedAt": null}]'::JSONB,
        'cursor', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001'), '10000000-0000-0000-0000-000000000003', pg_temp.head('10000000-0000-0000-0000-000000000003')),
        'hasMore', FALSE,
        'removedGroupIds', '[]'::JSONB
    ),
    'the old cursor picks up Canmore, which it had never seen, from the start'
);

-- A conflict sends its entry again: Alex edits the dinner from a version Sam has since changed.
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.expense('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Dinner', 1000, '20000000-0000-0000-0000-0000000000b1',
        '{"20000000-0000-0000-0000-0000000000a1": [0, 333], "20000000-0000-0000-0000-0000000000b1": [1000, 334], "20000000-0000-0000-0000-0000000000c1": [0, 333]}')
        || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000001'), 'notes', 'Sam''s note')),
    'applied', 'Sam adds a note to the dinner'
);
SELECT pg_temp.head('10000000-0000-0000-0000-000000000001') AS banff_before_conflict INTO TEMP banff_before_conflict;
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Dinner out', 1000, '20000000-0000-0000-0000-0000000000b1',
        '{"20000000-0000-0000-0000-0000000000a1": [0, 333], "20000000-0000-0000-0000-0000000000b1": [1000, 334], "20000000-0000-0000-0000-0000000000c1": [0, 333]}')
        || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000001') - 1)),
    'applied', 'Alex''s stale edit becomes a conflict'
);
SELECT results_eq(
    $$ SELECT e->>'id', (e->>'hasConflict')::BOOLEAN, e->>'description'
       FROM jsonb_array_elements(pg_temp.v1_entries(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000001',
            jsonb_build_object('10000000-0000-0000-0000-000000000001', (SELECT banff_before_conflict FROM banff_before_conflict)), 100)->'entries') e $$,
    $$ VALUES ('30000000-0000-0000-0000-000000000001', TRUE, 'Dinner') $$,
    'the dinner comes again with hasConflict, still the current version, on Banff''s own feed too'
);

-- A group the person left is reported, and leaves the cursor.
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000b3"}'), 'applied', 'Sam leaves Canmore');
SELECT is(
    pg_temp.v1_entries(pg_temp.token_hash('sam'), NULL, jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001'),
        '10000000-0000-0000-0000-000000000003', 1), 100),
    jsonb_build_object('entries', '[]'::JSONB, 'cursor', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001')),
        'hasMore', FALSE, 'removedGroupIds', '["10000000-0000-0000-0000-000000000003"]'::JSONB),
    'Canmore comes back in removedGroupIds and is left out of the cursor'
);
SELECT is(pg_temp.v1_entries(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000003', '{}', 100), NULL, 'Canmore''s own feed now returns NULL (HS404)');
SELECT is(pg_temp.v1_entries(pg_temp.token_hash('sam'), '10000000-0000-0000-0000-000000000002', '{}', 100), NULL, '... as does a group Sam was never in');

-- ---------------------------------------------------------------------------
-- What handshake_api can reach: the four api.v1_* functions, nothing else
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT array_agg(n.nspname || '.' || p.proname ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE has_function_privilege('handshake_api', p.oid, 'EXECUTE') AND has_schema_privilege('handshake_api', n.oid, 'USAGE')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_temp%'),
    ARRAY['api.v1_entries', 'api.v1_group', 'api.v1_groups', 'api.v1_me'],
    'outside the system catalogs, handshake_api can execute only the four api.v1_* functions'
);
SELECT is(
    (SELECT count(*)::INT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND has_table_privilege('handshake_api', c.oid, 'SELECT')
         AND has_schema_privilege('handshake_api', n.oid, 'USAGE') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_temp%'),
    0,
    '... and select no table'
);
SELECT is(pg_temp.sqlstate_as_api(format('SELECT * FROM %s', t)), '42501', 'handshake_api can''t read ' || t)
FROM unnest(ARRAY['public.api_tokens', 'public.groups', 'public.group_members', 'public.ledger_entries', 'public.ledger_shares', 'public.profiles', 'auth.users']) AS t;
SELECT is(pg_temp.sqlstate_as_api($$ SELECT public.push_changes('[]') $$), '42501', 'handshake_api can''t run push_changes');
SELECT is(pg_temp.sqlstate_as_api($$ SELECT public.pull_changes('{}') $$), '42501', '... or pull_changes');
SELECT is(pg_temp.sqlstate_as_api($$ SELECT public.create_api_token('x') $$), '42501', '... or make tokens');
SELECT is(pg_temp.sqlstate_as_api($$ SELECT private.api_authenticate('x') $$), '42501', '... or reach private');
SELECT is(pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', format('SELECT api.v1_me(%L)', pg_temp.token_hash('sam'))), '42501', 'a signed-in device can''t call api.v1_*');
SELECT is(pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SELECT * FROM public.api_tokens'), '42501', '... or read api_tokens');

SELECT * FROM finish();
ROLLBACK;
