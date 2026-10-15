# Voxden account service

Who a user is, and what their plan entitles them to. One Node process, one
SQLite file, no dependencies beyond Node 22.5 or newer (`node:sqlite`).

The desktop app never holds a payment or transcription secret. It talks to this
service with a session token; the cloud transcription relay
checks the same database before forwarding audio anywhere.

## Run

```bash
node server/index.js
```

For a VPS with TLS, backups and a pulled image, see [deploy/README.md](../deploy/README.md).
The container image is built from `server/Dockerfile` by the Account service
workflow on every push to `main` that touches this directory.

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | Listen port | `8787` |
| `VOXDEN_DB` | SQLite file | `server/data/voxden.sqlite` |
| `RESEND_API_KEY` | Email sign-in codes through Resend | unset: email sign-in returns `503`; no code is generated or logged |
| `MAIL_FROM` | Sender for Resend | `Voxden <sign-in@voxden.app>` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | A Google Cloud OAuth client of type "Desktop app"; enables "Continue with Google" (`GET /v1/auth/options`, `POST /v1/auth/google`). The secret stays here; the app never holds it | unset: emailed code only |
| `DISCORD_BUGS_WEBHOOK` | Webhook of the forum channel that receives bug reports from the app's Help menu (`POST /v1/feedback`); every report is stored in the `feedback` table either way | unset: bugs go to the ideas webhook, or only to the table |
| `DISCORD_IDEAS_WEBHOOK` | Webhook of the forum channel for ideas and other feedback | unset: only the table |
| `DISCORD_BOT_TOKEN` | Voxden Desk, the bot that tags each ticket Open or Done and answers `/done`, `/reopen` and `/open` in the server; it needs the invite with manage-threads, manage-channels and reactions permissions | unset: no bot |
| `CLOUD_HOURS_CAP` | Pro cloud hours per credit month | `15` |
| `CLOUD_CREDITS_CAP` | Pro cloud credits (1 credit = 1 minute) | hours × 60 |
| `CLOUD_WELCOME_CREDITS` | Credits in a subscriber's first credit month, once per account; `0`, or any figure not above the monthly one, turns the offer off | `1200` |
| `CLOUD_TRIAL_CREDITS` | Voxden Cloud credits (minutes) a free account may use once in its life, with no card: the Android app's free trial. Counted over the account's whole metered history; `0` turns the trial off and free accounts are refused the cloud routes | `60` |
| `CLOUD_CREDITS_RESET` | `month` refreshes with the calendar month; `never` is a lifetime pool | `month` |
| `GEOIP` | `off` turns regional pricing off: no account is placed in a region and the app offers every region | on |
| `GEOIP_DB` | DB-IP IP to Country Lite CSV, gzipped or not | `dbip-country-lite.csv.gz` beside the database |
| `GEOIP_UPDATE` | `off` stops the service downloading each month's table from DB-IP | on |
| `GEOIP_LOCAL_COUNTRY` | Country for private and loopback addresses, to try a region on a developer's PC (`IN`, `US`) | unset: no country |
| `OPENROUTER_API_KEY` | Key for the speech model behind `/v1/transcribe` | unset: that route answers `503` |
| `CLOUD_MODEL` | OpenRouter model slug of the main speech model. Production sets `assemblyai/universal-3-5-pro`. Its family decides the languages the relay accepts (below) and the retention it asks for: `provider.zdr: true` for `assemblyai/...` and `microsoft/...`, `provider.data_collection: "deny"` for any other family (both settings are merged with the dictionary's `provider.options`). A model of a family nobody has tried may have no endpoint that meets that policy and answer `404` to everything, so try a new one once before it ships | unset or empty: the default in `server/cloud.js` (`microsoft/mai-transcribe-2`) |
| `CLOUD_UPSTREAM_URL` | Transcription endpoint override, for tests | OpenRouter's |
| `CLOUD_HEDGE_MS` | How long (ms) a transcription request may go quiet before a second identical one is sent beside it; the first answer wins and the other is cancelled. Grows by 100 ms per second of audio, capped at 6 s. `0` turns it off. While a rescue model is on, the hedge is off unless this is set, and then both run | `2000` with no rescue model, otherwise off |
| `CLOUD_RESCUE_MODEL` | OpenRouter model slug sent ONE request per transcription, beside the main model, when the main model has not answered by `CLOUD_RESCUE_MS` or has failed with a 408, 429, 5xx or an unreachable error (that sends it at once). The first answer wins and every other request is cancelled; a failed rescue is ignored. Dictionary hints go to it the way its maker takes them: `assemblyai/...` gets the same cleaned list as the main model (up to 100 terms) as `provider.options.assemblyai.keyterms_prompt`, `openai/...` gets a `Vocabulary:` prompt (800 characters at most), and any other family gets none. A rescue that is the main model itself would only repeat the stalled request, so it is swapped for the other family's default. `assemblyai/universal-3-5-pro` won as a rescue on the owner's 72 clips (2026-10-12) at 8.9% word error and 22 of 27 dictionary words in 0.5-1.3 s, against 10.4% and 12 of 27 for `openai/gpt-4o-mini-transcribe`, at $0.45 per audio hour. An empty value or `none` turns the rescue off, so leave the variable out of an env file instead of leaving it blank. Production: `openai/gpt-4o-mini-transcribe` | unset: `assemblyai/universal-3-5-pro`, or `openai/gpt-4o-mini-transcribe` when the main model is AssemblyAI |
| `CLOUD_RESCUE_MS` | How long (ms) the main model may go quiet before the rescue is sent. Grows by 100 ms per second of audio, capped at 8 s. `0` turns the rescue off. The same allowance is how long a rescue still out is waited for once the main model has given up (a 429 after its retries, say), never past the 20 s deadline; if the rescue has not answered by then the main model's own error is returned, so the app still sees "returned 429" and can fall back to the local engine | `4000` |
| `CLOUD_WARMUP` | `auto`, `on` or `off`: whether the 0.3 s silent warm-up clip (at start, every ten minutes, and for each `POST /v1/transcribe/warm`) is sent to the speech model. `auto` skips it while the main model is `assemblyai/...`, which has no measured cold start, and sends it otherwise (MAI's cold start was measured). A skipped warm-up still answers yes and nothing is billed | `auto` |
| `CLOUD_BODY_MODEL` | OpenRouter model slug for the body lane (dictation lanes, below): the pieces a new app cuts while the user is still talking. Meant for `microsoft/mai-transcribe-2` | unset or empty: lanes off, everything goes to `CLOUD_MODEL` |
| `CLOUD_BODY_RESCUE_MODEL` | The body model's rescue, which also answers every piece hurried at stop. `none`, or a `CLOUD_BODY_RESCUE_MS` of `0`, leaves the lanes off (logged at start) | `assemblyai/universal-3-5-pro` |
| `CLOUD_BODY_RESCUE_MS` | How long (ms) a body piece may go quiet before its rescue is sent | `8000` |
| `CLOUD_BODY_WARMUP` | As `CLOUD_WARMUP`, for the body model | `auto` |
| `CLOUD_BODY_USERS` | Who the lanes are on for: comma-separated emails, or `*`. Clearing it and restarting is the rollback | empty: nobody |
| `CLOUD_SEGMENT_MIN_MS` / `CLOUD_SEGMENT_SILENCE_MS` / `CLOUD_SEGMENT_LONG_MS` / `CLOUD_SEGMENT_LONG_SILENCE_MS` | The piece sizes those accounts are told to cut at: a piece ends at a pause of the silence length once it is the minimum length, or at the long-silence pause once it is the long length | `4000` / `700` / `45000` / `300` |
| `CLOUD_BODY_CALLS` | Body pieces one account may have out at once (told to the app as `bodyConcurrency`) | `4` |
| `CLOUD_URGENT_DELAY_MS` | How long after the app stops a body piece still out waits before its rescue is sent | `0` |

Put it behind a reverse proxy that terminates TLS and sets `X-Forwarded-For`.
The app is built against `https://account.voxden.app/v1`; `VOXDEN_ACCOUNT_URL`
in the app's environment points it at a staging or local instance instead.

For local cloud testing, keep the service running and start the desktop with
`npm run start:local-cloud`. This uses `http://127.0.0.1:8787/v1` and the existing
development account. The session file remembers that address, so a later
`npm start` keeps talking to the local service instead of silently switching to
the production hostname. An explicit `VOXDEN_ACCOUNT_URL` still takes precedence.
It is also saved in the profile's `account-service.json` before sign-in, so
closing a fresh test install or signing out does not lose the selected server.
That file contains only the server address. Sessions are bound to their issuing
service and are not reused when an override selects another service.

## Endpoints

| Route | Body / header | Result |
|---|---|---|
| `POST /v1/auth/code` | `{ email }` | `204` only after the email provider accepts a six-digit code valid for 10 minutes. `503 email_unconfigured` without a mail provider; `503 email_delivery_failed` if sending fails; `429` for rate limits. Existing and new accounts follow the same path. |
| `GET /v1/auth/options` | | `{ google: { clientId } \| null, email: { configured } }`. Public capabilities only, never credentials. |
| `POST /v1/auth/verify` | `{ email, code, device }` | `200 { token, account }`. Five wrong attempts burn the code. |
| `GET /v1/me` | `Authorization: Bearer <token>` | `200 { account }`, or `401` when the session is gone. |
| `POST /v1/auth/signout` | Bearer token | `204`. Revokes that session. |
| `POST /v1/transcribe` | Bearer token, `{ audio, format, language, terms, lane?, dictation?, piece? }` | `200 { text, seconds, timing, cloud }`. The metered relay, below. |
| `POST /v1/transcribe/warm` | Bearer token, optional `?lane=body` | `204`. Wakes the speech model for a dictation that has just started; not metered. Same `402`/`503` gates as the relay. With an AssemblyAI main model no silent clip is sent (`CLOUD_WARMUP`). `?lane=body` also wakes the body model, for an account the lanes are on for. |
| `POST /v1/transcribe/urgent` | Bearer token, `{ dictation, pieces: [n, ...] }` (at most 64) | `200 { hurried, early }`. The app has stopped: sends the rescue now for each of the caller's body pieces still out (`hurried`), and marks for 30 s those not arrived yet so they go straight to `CLOUD_MODEL` (`early`). Session only: no concurrency slot, no credit check, nothing charged. |
| `GET /healthz` | | `200 { ok: true }` |

## The metered relay

`POST /v1/transcribe` is how a Pro user's dictation reaches the speech model
without the app ever holding the model key.

- `audio` is base64 of a PCM WAV (the app sends 16 kHz mono 16-bit), `format`
  is `wav`, `language` an optional ISO-639-1 code, `terms` up to 100 dictionary
  words passed to the model as keyword hints. While the main model is
  `assemblyai/...` a `language` it cannot take is refused with
  `400 { code: "language" }` before anything is reserved, sent or charged.
- The clip is measured from its own WAV header before anything is forwarded.
  A clip that would take the credit month past its allowance is refused with
  `402 { code: "cap" }` and no upstream call. Clips over five minutes are
  `413`; bodies over 12 MB are refused.
- A non-Pro account gets `402 { code: "plan" }`. A dead session gets `401`.
  An upstream failure is `502 { code: "upstream" }` or `{ code: "timeout" }`,
  and nothing is charged.
- On success the seconds the provider billed (or the header's, when it gives
  none), at least one per clip, are added to `usage` for the current UTC day,
  and the response carries the running total in `cloud.creditsUsed`. The
  minimum matters because AssemblyAI reports exact seconds and each request is
  rounded to a whole second, so a clip under half a second would otherwise be
  free.

A credit month runs from one billing date to the next, counted from the
renewal the payment provider last reported, and starts at midnight UTC. An
account with no subscription, such as a plan set with `grant.js`, uses the
calendar month. The first paid webhook an account ever receives records the
end of that period as its welcome month: that one credit month allows
`CLOUD_WELCOME_CREDITS` instead of the monthly figure, and every month after it
allows the monthly figure. Resubscribing later starts no second welcome month.

A free account gets a one-time trial of `CLOUD_TRIAL_CREDITS` minutes on
`/v1/transcribe`, `/v1/transcribe/warm` and `/v1/polish`, metered and reserved
exactly like Pro but against every second the account has ever had metered,
so an account that lapses out of Pro is free with its past use counted.
`account.trial` is `{ credits, used, left, available }`; a spent trial answers
`402` with `code: 'trial_used'`. The desktop app ignores the trial (it never
sends a free account's audio to the cloud); the Android app offers it.

Cloud dictation has one main speech model (`CLOUD_MODEL`) and, by default, one
rescue model beside it. The desktop sends completed phrases during recording,
after at least four seconds of audio and a 700 ms pause
(`src/cloud-segments.js`). Segments do not overlap; uninterrupted speech stays
in one request to preserve context. Stopping submits the final phrase, and
replies are joined in recording order. This overlaps batch recognition with
speaking; it is not native model streaming.

Each phrase goes to the main model, which is tried up to three times on a 408,
429, 500, 502, 503, 504 or unreachable answer. One request also goes to the
rescue model (`CLOUD_RESCUE_MODEL`) when the main model has been quiet for
`CLOUD_RESCUE_MS` or has failed with one of those errors; the first answer wins
and the other request is cancelled. A failed or empty rescue is ignored. If every main
attempt fails and the rescue is still out, it is waited for one more allowance
(`CLOUD_RESCUE_MS`, never past the 20 s deadline); if it has not answered by
then the main model's own error is returned, so a busy provider still reaches
the app as `502 upstream` / "returned 429" and not as a timeout. A refused
request (400 and the other 4xx, bad audio) is never rescued. If nothing
answers, the failure is reported and the full recording remains available for
a manual cloud retry when recording retention is enabled. Turning Cloud off
selects the existing on-device dictation path. Settings shows the last cloud
request's time; history records stop-to-paste time.

Every request asks OpenRouter for no retention: `provider.zdr: true` to
`assemblyai/...` and `microsoft/...`, `provider.data_collection: "deny"` to any
other family, the OpenAI rescue included (it answers a `zdr` request with a
`404`). Both were checked live on 2026-10-14, and sit beside the dictionary
hints in `provider`.

The startup and ten-minute warm-up calls, and the app's own warm-up at the
start of a recording and after three quiet seconds of one, keep a model with a
cold start warm. They submit 0.3 seconds of silence and can be billed by the
provider, so `CLOUD_WARMUP=auto` skips them while the main model is
`assemblyai/...` (no cold start is measured for it) and sends them for
`microsoft/...`. Deadlines cover both response headers and the response body.
The app also avoids local model startup and temporary WAV files for cloud
requests, and never waits for the optional correction observer before pasting.

To change the speech model, set `CLOUD_MODEL` (and `CLOUD_RESCUE_MODEL`) to
another OpenRouter slug. The dictionary reaches `assemblyai/...` and
`openai/...` models in their own formats, any other main model gets Azure's
phrase list, and a family with its own language list needs an entry in
`LANGUAGE_RULES` (`server/cloud.js`). A different API provider than OpenRouter
still needs an implementation change.

`account` is:

```json
{
  "email": "you@example.com",
  "plan": "pro",
  "planExpiresAt": "2027-01-01T00:00:00.000Z",
  "cloud": { "creditsUsed": 75, "creditsCap": 1200, "creditsRemaining": 1125, "hoursUsed": 1.25, "hoursCap": 20,
    "reset": "month", "periodEnd": "2026-10-20T00:00:00.000Z", "welcome": true, "monthlyCredits": 900 },
  "welcomeOffer": { "credits": 1200, "monthlyCredits": 900, "eligible": false },
  "serverTime": "2026-09-25T09:00:00.000Z"
}
```

`plan` is `free` or `pro`. An expired Pro reports `free`. `cloud.creditsUsed` is
whatever the relay has metered in the current credit month, which ends at
`cloud.periodEnd`; `cloud.welcome` says whether that month is the welcome
month. `welcomeOffer.eligible` is true while the offer is on and the account
has never had a paid period.

## Dictation lanes

With `CLOUD_BODY_MODEL` set, an app from 2.1.11 can name each piece's lane.
`lane: 'body'` is a piece cut while the user is still talking and goes to the
body model (MAI, with `CLOUD_BODY_RESCUE_MODEL` beside it after
`CLOUD_BODY_RESCUE_MS`); `lane: 'tail'` is the last piece, or anything unsent
when the user stops, and goes to `CLOUD_MODEL`. Each also carries `dictation`
(the recording's random id, 8-32 of `A-Z a-z 0-9 _ -`) and `piece` (0-999).
At stop the app posts the body pieces still out to `/v1/transcribe/urgent`,
and each one's rescue goes out at once (`CLOUD_URGENT_DELAY_MS` later, if set);
the first answer wins and the piece is charged once. A piece hurried before its
request arrived goes straight to `CLOUD_MODEL` when it does, within 30 s.

- Only accounts in `CLOUD_BODY_USERS` get the body model; for anyone else a
  body piece goes to `CLOUD_MODEL`. Requests without a valid `lane` (every app
  up to 2.1.10) are untouched: same model, same upstream body, same charge,
  same response.
- A lane piece is charged its exact audio seconds from the WAV header, at least
  one, whichever model answered, so smaller pieces cost the user no more.
- Concurrency per account: three general calls (no-lane clips, Polish,
  corrections), `CLOUD_BODY_CALLS` body pieces and six tail pieces, each
  counted apart. A body piece is in the body pool even when it ends up with
  `CLOUD_MODEL`. Reserved credits stay one total across the three. The lane
  pools are open to any cloud account, on the list or not: credits still bound
  what they can cost, and closing them would answer 429 to apps still cutting
  pieces right after the lanes are switched off.
- The answer's `timing` adds `lane`, `trigger` (`''`, `timer`, `error` or
  `urgent`: what sent the rescue) and `source` (`main` or `rescue`).
- The account (`/v1/me`) and every transcribe and Polish answer carry
  `cloud.dictation = { lanes: true, minSegmentMs, silenceMs, longSegmentMs,
  longSilenceMs, bodyConcurrency }` for an account the lanes are on for, and
  `dictation: null` for everyone else (lanes unset, refused, or not on the
  list), so an app that cached lane settings drops them on its next clip after
  a rollback rather than at its next `/v1/me`. Apps up to 2.1.10 ignore it.
- The language is checked against `CLOUD_MODEL` (so the same 18 are offered)
  and then sent to each model as its family spells it: Norwegian reaches MAI as
  `nb` and its AssemblyAI rescue as `no`. An OpenAI model is sent the code as
  it is.
- `/v1/transcribe/urgent` from an account the lanes are not on for answers
  `{ hurried: 0, early: 0 }` and writes no log line. At most 512 early marks
  are live per account and 20,000 in all; at the overall bound the caller's
  own oldest mark is dropped first.
- The log line of a lane piece ends with ` lane=<lane> piece=<n> model=<slug>`,
  a rescue sent at stop is described as "after the app stopped", and each
  urgent call is logged as `urgent for <email>: hurried n, early m`.

Rollback, in this order:

1. Switch the lanes off in the environment (`CLOUD_BODY_USERS=`, or unset
   `CLOUD_BODY_MODEL`) and restart. Body pieces go to `CLOUD_MODEL` at once.
2. Apps drop their cached lane settings on their next cloud answer, which now
   carries `dictation: null`, and go back to plain pieces.
3. Only after that, if the code itself must go, deploy a relay without lanes.
   Done first, the old relay sends no `dictation` at all, and apps keep the
   settings they cached until their next `/v1/me`, hours later.

## Limits

- 5 codes per email per hour, 30 per IP per hour, then `429`.
- Session tokens are 32 random bytes; only their SHA-256 is stored.
- Request bodies over 4 KB are refused.

## Payments

One hosted checkout, Razorpay, with a plan for each region. The app opens
Razorpay's page in the system browser and never sees a card; the plan flips
when the webhook lands here, and the app notices by refreshing `/v1/me` every
ten seconds while a checkout is pending. An event that does not say when the
paid period ends, such as `subscription.authenticated`, records the
subscription but changes no plan, in whichever order it arrives.

| Region | Price and methods | Variables |
|---|---|---|
| India | ₹349/month: UPI, cards, net banking | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_MONTHLY` |
| Everywhere else | $8/month: international cards | the same keys, plus `RAZORPAY_PLAN_MONTHLY_GLOBAL` |

A region is offered only when the keys and its monthly plan are set. New
purchases are monthly only, and both prices are fixed in `server/billing.js`.
Annual IDs are optional and retained only for legacy webhook recognition.

Razorpay is a payment gateway, not a merchant of record, so tax on these sales
is Voxden's own. The $8 offer is therefore closed in the countries that tax a
foreign seller's digital services from the first sale: the EU, the UK, Monaco
and the Isle of Man by default, or the ISO codes in `CLOSED_COUNTRIES`.
The options response includes the actual `cloudCreditsCap` and
`welcomeCreditsCap` (zero when there is no offer); the page must show those
allowances rather than advertising unlimited before it is implemented.

### Regions

India pays ₹349 and everywhere else $8, both through Razorpay.
Google sign-in says nothing about where someone is, so the service places each
account from the internet address of its first sign-in: `IN` is the India
region, every other country is global. The region is saved on the account
(`users.region`, with the deciding `users.country`) and never changes after
that, wherever the account signs in from. An account first seen from an
address no table can place, such as `127.0.0.1` with no `GEOIP_LOCAL_COUNTRY`,
is placed by its first later request that can be.

- `GET /v1/billing/options` answers `{ region, options }`. Signed in, only the
  account's region's plan is listed; signed out, the region of the request's
  address; unplaceable, every region. A global account or address in a closed
  country gets no options and `unavailable: "country"`.
- `/v1/me` carries `account.region` (`in`, `global` or `null`). The app shows
  that region's price alone and no region picker.
- `POST /v1/billing/checkout` takes `{ provider, plan, region }`. A placed
  account always checks out in its own region, and asking for the other one is
  `400 { code: "region" }`, so hiding a price is never the only guard. An
  unplaced account's `region` picks the plan; without one, India. A global
  account in a closed country is `400 { code: "country" }`.
- `node server/region.js <email> <in|global|show>` corrects a region by hand,
  for someone whose first sign-in came through a VPN or from abroad.

The country table is DB-IP's free IP to Country Lite database, IP Geolocation
by DB-IP (https://db-ip.com), under CC BY 4.0; Plans & billing credits it
under the prices. The service downloads the current month's file into
`GEOIP_DB` when its copy is from an earlier month, checks once a day, and keeps
the table it has when a download fails. It reads the client address from
`X-Forwarded-For`, which the proxy must set from the real client.

Setup on the provider side, once:

- India: create a monthly plan with `period=monthly`, `interval=1`,
  `item.amount=34900`, and `item.currency=INR`; set `RAZORPAY_PLAN_MONTHLY`
  to that ID.
- Everywhere else: turn on International cards for the account, then create a
  second plan with `item.amount=800` and `item.currency=USD`, otherwise the
  same; set `RAZORPAY_PLAN_MONTHLY_GLOBAL` to that ID.
- Checkout fetches the plan and refuses any different price, currency or
  interval before creating a subscription. Plans cannot be edited, so a new
  price is a new plan. Add a webhook to `https://<host>/v1/billing/webhook/razorpay`
  for the `subscription.*` events with the webhook secret; both plans share it.

What a webhook does here:

- The signature over the raw body is checked first (`X-Razorpay-Signature`,
  HMAC-SHA256). Bad signature is `400`, and nothing else happens.
- Events are idempotent by key (Razorpay's event id, or a hash of the body),
  so a provider retry is acknowledged and ignored.
- The user is found by the id put in the checkout's notes, falling back to the
  customer email.
- An active or paid event sets the plan to Pro until the period end plus
  three days of renewal grace. A cancellation, pause or expiry sets it to run
  out exactly at the period end, so a cancelled user keeps what they paid for.
- Every verified event answers `200`, including ones not acted on.

The provider request and event shapes follow their public docs and are
exercised by `scripts/test-billing.js` against fixtures; the first live
checkout is the test of the docs.

### Google Play Billing (the Android Play build)

Play's policy requires Play Billing for a subscription sold inside an app on
Play, so the Android Play build does not open the Razorpay page. The app buys
on Google's own sheet, then reports the purchase token here; the service asks
Google's Play Developer API what the token is worth, acknowledges it (Google
refunds an unacknowledged purchase after three days) and switches Pro on.
Renewals, cancellations, holds and refunds arrive as Play's real-time
notifications. Play is the merchant of record, so `CLOSED_COUNTRIES` does not
apply, and the price is whatever Play Console says for the buyer's country.

- `GET /v1/billing/googleplay` (Bearer) gives the app the product ID and the
  buyer's obfuscated account id to hand to Play, or `{ configured: false }`.
  `blocked: "subscription"` means another subscription still has time on it.
- `POST /v1/billing/googleplay/purchase` (Bearer, `{ productId, purchaseToken }`)
  answers `200` with the billing status, `202` while a slow payment settles,
  `400` for a token Google does not know, `409` for a purchase made for or
  already held by another account, `502` when Google does not answer (the
  app tries again; the purchase is safe at Google).
- `POST /v1/billing/webhook/googleplay?key=<GOOGLE_PLAY_PUSH_KEY>` is the
  Pub/Sub push endpoint. A notification is only a hint: the token in it is
  looked up at Google, and an account is found by the token's row or the
  obfuscated id, so a forged message grants nothing. Non-2xx makes Pub/Sub send
  it again; only a Google failure answers that way.
- A cancelled subscription runs to the end of the paid period with no grace; an
  older purchase's late expiry never shortens a newer subscription.
- Cancelling from Plans and billing asks Google to stop renewals
  (`USER_REQUESTED_STOP_RENEWALS`); the user can undo it in Play.

| Variable | Meaning |
|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` or `_FILE` | the Play Developer API service account's key; unset leaves Google Play billing off |
| `GOOGLE_PLAY_PACKAGE` | the app's package, default `com.voxden.android` |
| `GOOGLE_PLAY_PRODUCT` | the subscription's product ID, default `voxden_pro` |
| `GOOGLE_PLAY_PUSH_KEY` | a long random string in the push address |

Setting it up, from Google's docs as of 2026-10 (the first license-tester
purchase is the check): in Play Console, Setup › API access, link a Cloud
project and make a service account with the permissions to view financial data
and manage orders and subscriptions; create the `voxden_pro` subscription with a
monthly base plan and a price per country; under Monetization setup, set the
real-time notifications topic and add a Pub/Sub push subscription pointing at
the endpoint above; allow `google-play-developer-notifications@system.gserviceaccount.com`
to publish to the topic; add license testers so test purchases cost nothing.
Tested by `scripts/test-google-play.js` against a stand-in for Google.

### Review login (for Google Play's app reviewers)

Play's reviewers cannot read an emailed code, and may not use a personal account
or buy anything. `REVIEW_LOGIN_EMAIL` and `REVIEW_LOGIN_CODE` (exactly six
digits) give one address a fixed code: asking for a code sends no email, the code
signs in, and that account is kept on Pro (thirty days from each sign-in). It
uses the ordinary code table, so the limits still apply: five tries a code and
twenty wrong codes a day, after which the address is locked until the next day.
Hand the pair to Google in Play Console only, use an address that is not a real
person's, and unset both variables when the review is over. Tested by
`scripts/test-review-login.js`.

## The signing goal

voxden.app/support and the download page carry a live bar toward
code-signing Voxden. Anyone can chip in any amount from ₹50 or $1 up to
₹50,000 or $500, with no account.

| Route | Result |
|---|---|
| `GET /v1/support` | `{ goalInr, raisedInr, contributions, deadline, usdInr, recent, open, serverTime }`. `recent` holds amounts and times only. |
| `GET /v1/support/stream` | The same as server-sent events: once on connect, then after every recorded payment, with a comment every 25 s. At 2,000 open streams it answers `503` and pages poll instead. |
| `POST /v1/support/order` | `{ amount, currency }` in the smallest unit (paise or cents) → `{ orderId, keyId, amount, currency }`, a Razorpay order the page pays in Razorpay's own checkout. Twenty orders an hour for each address. |

- These three are the only routes that answer CORS, and only for the origins
  in `SUPPORT_ORIGINS` (voxden.app and www by default).
- Only a signed `order.paid` webhook whose order carries the note
  `voxden_kind: support` moves the total, once per payment id, into the
  `support_payments` table. Subscription orders are ignored. The live Razorpay
  webhook must include `order.paid` for this to work.
- Dollar payments are stored in rupees at `SUPPORT_USD_INR` as it stood when
  they arrived.
- `SUPPORT_GOAL_INR` and `SUPPORT_DEADLINE` set the goal and the countdown.
  The page's milestones are in `site/download.html` and `site/support.html`.
- `deploy/Caddyfile` leaves `/v1/support/stream` out of compression, so
  events are not held back in a buffer.

`scripts/test-support.js` covers it against a stand-in for Razorpay's API.
No real `order.paid` has reached the service yet.

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
node scripts/test-google-play.js
node scripts/test-cloud-relay.js
node scripts/test-cloud-lanes-relay.js
```

Runs the whole flow against an in-memory database on an ephemeral port.
