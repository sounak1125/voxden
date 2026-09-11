# Voxden account service

Who a user is, and what their plan entitles them to. One Node process, one
SQLite file, no dependencies beyond Node 22.5 or newer (`node:sqlite`).

The desktop app never holds a payment or transcription secret. It talks to this
service with a session token; the cloud transcription relay (separate, later)
checks the same database before forwarding audio anywhere.

## Run

```bash
node server/index.js
```

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | Listen port | `8787` |
| `VOXDEN_DB` | SQLite file | `server/data/voxden.sqlite` |
| `RESEND_API_KEY` | Email sign-in codes through Resend | unset: codes print to stdout |
| `MAIL_FROM` | Sender for Resend | `Voxden <sign-in@voxden.app>` |
| `CLOUD_HOURS_CAP` | Pro cloud hours per calendar month | `10` |
| `OPENROUTER_API_KEY` | Key for the speech model behind `/v1/transcribe` | unset: that route answers `503` |
| `CLOUD_MODEL` | OpenRouter model slug | `microsoft/mai-transcribe-2` |
| `CLOUD_UPSTREAM_URL` | Transcription endpoint override, for tests | OpenRouter's |

Put it behind a reverse proxy that terminates TLS and sets `X-Forwarded-For`.
The app is pointed at it with `VOXDEN_ACCOUNT_URL` (for example
`https://account.example.com/v1`) until the production URL is baked in.

## Endpoints

| Route | Body / header | Result |
|---|---|---|
| `POST /v1/auth/code` | `{ email }` | `204`. Emails a six-digit code valid for 10 minutes. Always `204` for a well-formed address so nobody can probe who has an account. |
| `POST /v1/auth/verify` | `{ email, code, device }` | `200 { token, account }`. Five wrong attempts burn the code. |
| `GET /v1/me` | `Authorization: Bearer <token>` | `200 { account }`, or `401` when the session is gone. |
| `POST /v1/auth/signout` | Bearer token | `204`. Revokes that session. |
| `POST /v1/transcribe` | Bearer token, `{ audio, format, language, terms }` | `200 { text, seconds, cloud }`. The metered relay, below. |
| `GET /healthz` | | `200 { ok: true }` |

## The metered relay

`POST /v1/transcribe` is how a Pro user's dictation reaches the speech model
without the app ever holding the model key.

- `audio` is base64 of a PCM WAV (the app sends 16 kHz mono 16-bit), `format`
  is `wav`, `language` an optional ISO-639-1 code, `terms` up to 100 dictionary
  words passed to the model as keyword hints.
- The clip is measured from its own WAV header before anything is forwarded.
  A clip that would take the month past `CLOUD_HOURS_CAP` is refused with
  `402 { code: "cap" }` and no upstream call. Clips over five minutes are
  `413`; bodies over 12 MB are refused.
- A non-Pro account gets `402 { code: "plan" }`. A dead session gets `401`.
  An upstream failure is `502 { code: "upstream" }` or `{ code: "timeout" }`,
  and nothing is charged.
- On success the seconds the provider billed (or the header's, when it gives
  none) are added to `usage` for the current UTC month, and the response
  carries the running total in `cloud.hoursUsed`.

The desktop app treats every one of those failures the same way: it
transcribes the clip on the PC instead, and Settings › Speech engines says
which engine took the last dictation and why.

The model is a string in the environment. Swapping providers is a restart of
this service, not an app update.

`account` is:

```json
{
  "email": "you@example.com",
  "plan": "pro",
  "planExpiresAt": "2027-01-01T00:00:00.000Z",
  "cloud": { "hoursUsed": 1.25, "hoursCap": 10, "periodEnd": "2026-10-01T00:00:00.000Z" },
  "serverTime": "2026-09-11T09:00:00.000Z"
}
```

`plan` is `free` or `pro`. An expired Pro reports `free`. `cloud.hoursUsed` is
whatever the relay has metered this month; the relay writes `usage`, this
service only reads it.

## Limits

- 5 codes per email per hour, 30 per IP per hour, then `429`.
- Session tokens are 32 random bytes; only their SHA-256 is stored.
- Request bodies over 4 KB are refused.

## Payments

Two hosted checkouts, chosen by the user by region. The app opens the
provider's page in the system browser and never sees a card; the plan flips
when the provider's webhook lands here, and the app notices by refreshing
`/v1/me` every ten seconds while a checkout is pending.

| Provider | Region | Variables |
|---|---|---|
| Razorpay | India (UPI, cards, net banking) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_MONTHLY`, `RAZORPAY_PLAN_ANNUAL` |
| Lemon Squeezy | Everywhere else (merchant of record: VAT and invoices are theirs) | `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_VARIANT_MONTHLY`, `LEMONSQUEEZY_VARIANT_ANNUAL` |

A provider is offered only when every one of its variables is set. Price
labels shown in the app come from `PRICE_IN_MONTHLY`, `PRICE_IN_ANNUAL`,
`PRICE_GLOBAL_MONTHLY`, `PRICE_GLOBAL_ANNUAL`, defaulting to ₹299 / ₹2,388 and
$8 / $72.

Setup on the provider side, once:

- Razorpay: create two subscription plans (monthly, annual) and put their ids
  in the plan variables. Add a webhook to `https://<host>/v1/billing/webhook/razorpay`
  for the `subscription.*` events with the webhook secret.
- Lemon Squeezy: one product with a monthly and an annual variant; put the
  variant ids in. Add a webhook to `https://<host>/v1/billing/webhook/lemonsqueezy`
  for the `subscription_*` events with the signing secret.

What a webhook does here:

- The signature over the raw body is checked first (`X-Razorpay-Signature` or
  `X-Signature`, HMAC-SHA256). Bad signature is `400`, and nothing else happens.
- Events are idempotent by key (Razorpay's event id, or a hash of the body),
  so a provider retry is acknowledged and ignored.
- The user is found by the id put in the checkout's notes or custom data,
  falling back to the customer email.
- An active or paid event sets the plan to Pro until the period end plus
  three days of renewal grace. A cancellation, pause or expiry sets it to run
  out exactly at the period end, so a cancelled user keeps what they paid for.
- Every verified event answers `200`, including ones not acted on.

The provider request and event shapes follow their public docs and are
exercised by `scripts/test-billing.js` against fixtures; the first live
checkout is the test of the docs.

## Grant a plan by hand

Until payments exist:

```bash
node server/grant.js someone@example.com pro 2027-01-01
```

The user must have signed in once. The app picks the change up on its next
entitlement refresh (at launch and every six hours), or at once from
Settings › Account › Refresh.

## Tests

```bash
node scripts/test-account-server.js
```

Runs the whole flow against an in-memory database on an ephemeral port.
