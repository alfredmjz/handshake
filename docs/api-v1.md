# Handshake API v1

- **Status:** Contract for the MVP. Pholio's side is built against this document.
- **Created:** 2026-11-03
- **Updated:** 2026-11-04 (payments feed replaces the entries feed; nothing had shipped)
- **Machine-readable:** `docs/api-v1.openapi.yaml` (OpenAPI 3.1). Where prose and YAML differ, the YAML is
  right and this document is fixed.
- **Design:** `docs/architecture.md` (ADR-001 to ADR-004), `docs/shared-ledger-spec.md` (the money model)

Handshake tracks who owes who inside friend groups. No money moves through it; it only keeps the record.
This API lets another app (first, Pholio) read **the money one person sent and received**: the payments
they made to friends and the payments friends made to them, once both sides have confirmed them (a
handshake). Bills stay in Handshake. Handshake never calls the other app.

## Basics

- **Base URL:** `https://<handshake domain>/api/v1`
- **Method:** `GET` only. `OPTIONS` answers CORS preflights.
- **Format:** JSON, UTF-8, camelCase field names.
- **Money:** whole cents in fields ending `Cents` (integers, never floats). Dollars only; there is no
  currency field.
- **Dates:** `entryDate` is a calendar date `YYYY-MM-DD` chosen by the person. Timestamps are ISO 8601 in
  UTC with milliseconds: `2026-11-04T18:20:00.000Z`.
- **IDs:** UUID strings. They never change and are never reused.
- **Whose view:** every response is about the person who owns the token.

## Authentication

The person creates a token in Handshake (**Settings → Connected apps → Connect an app**), sees it once,
and pastes it into Pholio. It looks like `hsk_` followed by 43 base64url characters.

```
Authorization: Bearer hsk_3q2-7wZ…
```

- Send it only in the `Authorization` header, never in a URL.
- A token can read exactly what its owner can see in Handshake, and nothing can be written with it.
- Tokens don't expire. The person can revoke one at any time, and deleting their Handshake account
  deletes every token; from then on it gets `401 invalid_token`. Pholio should then ask the person to
  connect again.
- Keep the token on Pholio's server. CORS is open (`Access-Control-Allow-Origin: *`) because the API uses no
  cookies, but a token held in a browser can be stolen by any script on that page.

## Endpoints

| Method and path                  | Returns                                                |
| -------------------------------- | ------------------------------------------------------ |
| `GET /me`                        | The token's owner                                      |
| `GET /groups`                    | Their groups, each with their balance                  |
| `GET /groups/{groupId}`          | One group, plus their own debts in it                  |
| `GET /groups/{groupId}/payments` | That group's payments involving them, as a change feed |
| `GET /payments`                  | Their payments across all groups, as a change feed     |

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
			"balanceCents": 333,
			"completedAt": null,
			"updatedAt": "2026-11-04T18:20:00.000Z"
		}
	]
}
```

| Field          | Meaning                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `role`         | `owner`, `member` or `guest`. New values may be added in v1; treat unknown ones as `member`.     |
| `memberId`     | The person's member id in this group.                                                            |
| `balanceCents` | What everyone in the group owes the person minus what they owe everyone. Positive: they're owed. |
| `completedAt`  | When the owner completed the group (read-only from then on), or `null`.                          |
| `updatedAt`    | The last time the group, its people or its entries changed.                                      |

### `GET /groups/{groupId}`

The group as in `GET /groups`, plus `debts`: the person's own debts in it, one per other person, worked
out between the two of them. People they're square with aren't listed.

Sam after a $10.00 dinner Sam paid, split by Alex, Jo and Sam, and a $3.33 payment from Alex that both
confirmed:

```json
{
	"id": "9b1e…",
	"name": "Banff trip",
	"role": "member",
	"memberId": "c4d2…",
	"balanceCents": 333,
	"completedAt": null,
	"updatedAt": "2026-11-04T18:20:00.000Z",
	"debts": [{ "memberId": "b7…", "name": "Jo", "direction": "owes_you", "amountCents": 333 }]
}
```

| Field       | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `direction` | `owes_you` (they owe the person) or `you_owe`. |
| `name`      | The other person's name in this group.         |

`404 not_found` if the group doesn't exist, the person isn't in it, or it was deleted.

### `GET /payments` and `GET /groups/{groupId}/payments`

A **change feed** of the payments that involve the person and **count**: both sides confirmed them, or
the other side has no Handshake login (someone tracked by name only), in which case recording it was
enough. The first call returns everything; later calls return only what's new. A payment that counts
never changes, so the feed only ever adds payments.

| Parameter | Default | Meaning                                                                                |
| --------- | ------- | -------------------------------------------------------------------------------------- |
| `cursor`  | none    | The `nextCursor` from the previous response. Leave it out to start from the beginning. |
| `limit`   | 100     | 1 to 500. A page can hold slightly more when several payments counted together.        |

```json
{
	"payments": [
		{
			"id": "e81f…",
			"groupId": "9b1e…",
			"groupName": "Banff trip",
			"direction": "received",
			"counterpartyMemberId": "a1…",
			"counterpartyName": "Alex",
			"amountCents": 333,
			"entryDate": "2026-11-04",
			"notes": null,
			"confirmedAt": "2026-11-04T18:20:00.000Z"
		}
	],
	"nextCursor": "eyJ2IjoxLCJzY29wZSI6ImFsbCIsImdyb3VwcyI6eyI5YjFlLi4uIjo3fX0",
	"hasMore": false,
	"removedGroupIds": []
}
```

| Field              | Meaning                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`        | `sent` (the person paid someone back: money out) or `received` (someone paid them back: money in).                                                                                                                                                              |
| `counterpartyName` | The other person's name in that group.                                                                                                                                                                                                                          |
| `amountCents`      | The amount paid back, always positive.                                                                                                                                                                                                                          |
| `entryDate`        | The day the payment happened, as recorded.                                                                                                                                                                                                                      |
| `notes`            | The note on the payment, or `null`.                                                                                                                                                                                                                             |
| `confirmedAt`      | When it started to count.                                                                                                                                                                                                                                       |
| `nextCursor`       | Always present. Store it and send it next time.                                                                                                                                                                                                                 |
| `hasMore`          | `true`: call again now with `nextCursor`; more payments are waiting.                                                                                                                                                                                            |
| `removedGroupIds`  | Groups Pholio has seen through this cursor that the person has since left, or that were deleted. Pholio decides what to do with their payments; the money did move. They don't appear again unless the person rejoins, which sends that group's payments again. |

Pending, declined and undone payments are never returned. The cursor is opaque. Don't parse it or build
one; it only works on the endpoint that issued it (a `/groups/{id}/payments` cursor sent to `/payments`
gets `400 bad_request`). Payments in a page are not in date order.

#### Keeping Pholio in sync

```
cursor = stored cursor (or none)
repeat:
    page = GET /payments?cursor=cursor
    add every payment by id (an id already seen can be skipped)
    handle page.removedGroupIds
    cursor = page.nextCursor
until page.hasMore is false
store cursor
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
- Never in v1: removing or renaming a field, changing a type or meaning, new `direction` values, or a new
  required parameter. Those go in `/api/v2`, and v1 keeps working for at least 6 months after v2 ships.
- Every change to this contract updates `docs/api-v1.openapi.yaml` in the same commit, and Handshake's
  contract tests check every response against it.

## Not in v1

Writing anything, webhooks, OAuth ("Sign in with Handshake"; it would change only how the bearer token is
issued), bills and their items, other people's debts, pending payments, chat and nudges, and trip
planning.
