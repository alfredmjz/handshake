# Handshake API v1

- **Status:** Contract for the MVP. Pholio's side is built against this document.
- **Created:** 2026-11-03
- **Machine-readable:** `docs/api-v1.openapi.yaml` (OpenAPI 3.1). Where prose and YAML differ, the YAML is
  right and this document is fixed.
- **Design:** `docs/architecture.md` (ADR-001 to ADR-004), `docs/shared-ledger-spec.md` (the money model)

Handshake tracks who owes who inside friend groups. No money moves; Handshake only keeps the record. This
API lets another app (first, Pholio) read what one person paid, owes and is owed, read-only. Handshake
never calls the other app.

## Basics

- **Base URL:** `https://<handshake domain>/api/v1`
- **Method:** `GET` only. `OPTIONS` answers CORS preflights.
- **Format:** JSON, UTF-8, camelCase field names.
- **Money:** whole cents in fields ending `Cents` (integers, never floats). Dollars only; there is no
  currency field.
- **Dates:** `entryDate` is a calendar date `YYYY-MM-DD` chosen by the person. Timestamps are ISO 8601 in
  UTC with milliseconds: `2026-11-03T18:20:00.000Z`.
- **IDs:** UUID strings. They never change and are never reused.
- **Whose view:** every response is about the person who owns the token. Amounts are **their** share.

## Authentication

The person creates a token in Handshake (**Settings → Connected apps → Connect an app**), sees it once,
and pastes it into Pholio. It looks like `hsk_` followed by 43 base64url characters.

```
Authorization: Bearer hsk_3q2-7wZ…
```

- Send it only in the `Authorization` header, never in a URL.
- A token can read exactly what its owner can see in Handshake, and nothing can be written with it.
- Tokens don't expire. The person can revoke one at any time; from then on it gets `401 invalid_token`.
  Pholio should then ask the person to connect again.
- Keep the token on Pholio's server. CORS is open (`Access-Control-Allow-Origin: *`) because the API uses no
  cookies, but a token held in a browser can be stolen by any script on that page.

## Endpoints

| Method and path                 | Returns                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `GET /me`                       | The token's owner                                        |
| `GET /groups`                   | Their groups, each with their paid, owed and balance     |
| `GET /groups/{groupId}`         | One group, plus the suggested payments that involve them |
| `GET /groups/{groupId}/entries` | That group's entries, as a change feed                   |
| `GET /entries`                  | Entries across all their groups, as a change feed        |

### `GET /me`

```json
{ "userId": "5f0c…", "displayName": "Sam" }
```

### `GET /groups`

Every group the person is in now, including completed ones, sorted by name (case-insensitive). Groups
they left or that were deleted are not listed.

```json
{
	"groups": [
		{
			"id": "9b1e…",
			"name": "Banff trip",
			"role": "member",
			"memberId": "c4d2…",
			"paidCents": 1000,
			"owedCents": 334,
			"balanceCents": 666,
			"completedAt": null,
			"updatedAt": "2026-11-03T18:20:00.000Z"
		}
	]
}
```

| Field          | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `role`         | `owner`, `member` or `guest`. New values may be added in v1; treat unknown ones as `member`. |
| `memberId`     | The person's member id in this group; entries and `settleUp` refer to members by this id.    |
| `paidCents`    | Total the person paid across the group's entries that aren't deleted.                        |
| `owedCents`    | Total the person owes from those entries.                                                    |
| `balanceCents` | `paidCents − owedCents`. Positive: others owe them. Negative: they owe.                      |
| `completedAt`  | When the owner completed the group (read-only from then on), or `null`.                      |
| `updatedAt`    | The last time the group, its people or its entries changed.                                  |

### `GET /groups/{groupId}`

The group as in `GET /groups`, plus `settleUp`: the suggested payments that settle the group, filtered to
the ones that involve the person. Suggestions come from everyone's balances with Handshake's own rule
(the person owing most pays the person owed most, repeated), so they match what the app shows.

Sam after a $10.00 dinner Sam paid, split by Alex, Jo and Sam:

```json
{
	"id": "9b1e…",
	"name": "Banff trip",
	"role": "member",
	"memberId": "c4d2…",
	"paidCents": 1000,
	"owedCents": 334,
	"balanceCents": 666,
	"completedAt": null,
	"updatedAt": "2026-11-03T18:20:00.000Z",
	"settleUp": [
		{ "fromMemberId": "a1…", "fromName": "Alex", "toMemberId": "c4d2…", "toName": "Sam", "amountCents": 333 },
		{ "fromMemberId": "b7…", "fromName": "Jo", "toMemberId": "c4d2…", "toName": "Sam", "amountCents": 333 }
	]
}
```

Sam owes 334 rather than 333 because the person who paid absorbs the rounding cent.

`404 not_found` if the group doesn't exist, the person isn't in it, or it was deleted.

### `GET /entries` and `GET /groups/{groupId}/entries`

A **change feed** of entries: the first call returns everything, later calls return only what changed.

| Parameter | Default | Meaning                                                                                |
| --------- | ------- | -------------------------------------------------------------------------------------- |
| `cursor`  | none    | The `nextCursor` from the previous response. Leave it out to start from the beginning. |
| `limit`   | 100     | 1 to 500. A page can hold slightly more when several entries changed together.         |

```json
{
	"entries": [
		{
			"id": "e81f…",
			"groupId": "9b1e…",
			"kind": "expense",
			"description": "Dinner",
			"entryDate": "2026-11-02",
			"totalCents": 1000,
			"involved": true,
			"paidCents": 1000,
			"owedCents": 334,
			"netCents": 666,
			"hasConflict": false,
			"createdAt": "2026-11-03T18:20:00.000Z",
			"updatedAt": "2026-11-03T18:20:00.000Z",
			"deletedAt": null
		}
	],
	"nextCursor": "eyJ2IjoxLCJzY29wZSI6ImFsbCIsImdyb3VwcyI6eyI5YjFlLi4uIjo3fX0",
	"hasMore": false,
	"removedGroupIds": []
}
```

| Field             | Meaning                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`            | `expense` (a bill) or `payment` (someone paying someone back). No other values in v1.                                                                                                                                |
| `description`     | Up to 120 characters; payments default to "Payment".                                                                                                                                                                 |
| `totalCents`      | The whole bill or payment.                                                                                                                                                                                           |
| `involved`        | Whether the person has a share in it. Entries they aren't in come through with `false` and zeros.                                                                                                                    |
| `paidCents`       | What the person paid towards it. For a payment, the person paying back has `paidCents` = the amount.                                                                                                                 |
| `owedCents`       | What the person owes from it. For a payment, the person receiving has `owedCents` = the amount.                                                                                                                      |
| `netCents`        | `paidCents − owedCents`: this entry's effect on their balance.                                                                                                                                                       |
| `hasConflict`     | Two people edited it at once and the group hasn't resolved it yet. The amounts are the current version and may change when it is resolved; the entry then comes through again.                                       |
| `deletedAt`       | Set when the entry was deleted. Remove it on Pholio's side.                                                                                                                                                          |
| `nextCursor`      | Always present. Store it and send it next time.                                                                                                                                                                      |
| `hasMore`         | `true`: call again now with `nextCursor`; more changes are waiting.                                                                                                                                                  |
| `removedGroupIds` | Groups Pholio has seen through this cursor that the person has since left, or that were deleted. Drop their entries. They don't appear again unless the person rejoins, which sends the group's whole history again. |

For any group, the sum of `netCents` over its entries without `deletedAt` equals that group's
`balanceCents`.

The cursor is opaque. Don't parse it or build one; it only works on the endpoint that issued it (a
`/groups/{id}/entries` cursor sent to `/entries` gets `400 bad_request`). Entries in a page are not in date
order; treat a page as a set of changes. An entry can appear more than once across pages when it changed
again in between; the later copy wins.

#### Keeping Pholio in sync

```
cursor = stored cursor (or none)
repeat:
    page = GET /entries?cursor=cursor
    upsert every entry by id; delete the ones with deletedAt
    delete every entry whose groupId is in page.removedGroupIds
    cursor = page.nextCursor
until page.hasMore is false
store cursor
GET /groups for current balances
```

Once a minute or less often is plenty; the rate limit is 60 requests a minute per token.

## Errors

Every error has the same body:

```json
{ "error": { "code": "invalid_token", "message": "The token is missing, unknown or revoked." } }
```

| Status | `code`               | When                                                                       | Headers                    |
| ------ | -------------------- | -------------------------------------------------------------------------- | -------------------------- |
| 400    | `bad_request`        | A bad `limit`, a cursor that isn't valid or belongs to another endpoint    |                            |
| 401    | `invalid_token`      | No `Authorization` header, a malformed token, or an unknown or revoked one | `WWW-Authenticate: Bearer` |
| 404    | `not_found`          | Unknown path, or a group that doesn't exist or the person can't see        |                            |
| 405    | `method_not_allowed` | Anything other than `GET` or `OPTIONS`                                     | `Allow: GET, OPTIONS`      |
| 429    | `rate_limited`       | More than 60 requests in the current minute with this token                | `Retry-After` (seconds)    |
| 500    | `server_error`       | Something failed on Handshake's side; retry later                          |                            |

Branch on `code`, not on `message`; messages are for people and may change.

## Headers on every response

- `Content-Type: application/json; charset=utf-8` (except `204` to `OPTIONS`)
- `Cache-Control: no-store`
- `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization`,
  `Access-Control-Allow-Methods: GET, OPTIONS`, and on `OPTIONS` `Access-Control-Max-Age: 86400`

## Versioning

- Within v1, changes are **additive only**: new endpoints, new optional parameters, new response fields,
  new `role` values. Pholio must ignore fields it doesn't know.
- Never in v1: removing or renaming a field, changing a type or meaning, new `kind` values, or a new
  required parameter. Those go in `/api/v2`, and v1 keeps working for at least 6 months after v2 ships.
- Every change to this contract updates `docs/api-v1.openapi.yaml` in the same commit, and Handshake's
  contract tests check every response against it.

## Not in v1

Writing anything, webhooks, OAuth ("Sign in with Handshake"; it would change only how the bearer token is
issued), bill items, other people's shares, member lists, and trip planning.
