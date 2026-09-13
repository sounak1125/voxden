# Voxden India billing

Updated 12 September 2026: **INR 349/month. No annual offer for now.**

## Current implementation

- A dedicated Plans & billing settings page uses the approved charcoal background, neutral cards, soft green accent, Segoe UI typography, 12px cards and 8px controls.
- src/theme.css is the shared theme for dictation, dictionary, writing style, insights, help, settings, dialogs, notifications, the flow bar and capture controls.
- India offers INR 349/month. Existing global monthly pricing remains separate by region.
- Annual purchases are absent from the page and rejected by the server, including requests from older clients. Existing annual subscription events remain readable; existing subscribers are not repriced.
- Razorpay checkout verifies amount 34900 paise, currency INR, monthly period and interval 1 before creating a subscription. A stale INR 299 plan ID cannot silently charge the old amount.
- A merchant still needs to configure the matching Razorpay plan ID and deploy the server changes. This task did not change external payment-provider products or active subscriptions.
- The server still meters a configurable Pro allowance, default 20 cloud hours (1,200 credits)/month since 13 September 2026, and uses the current cloud recognizer. Billing shows the actual allowance. Unlimited cloud routing remains proposed and is not advertised as implemented.
- Free is metered too: 3,000 dictated words per seven-day period, on the on-device engine the user chose. The week starts on the first dictation and lapses seven days later; a dictation already under way is never cut short, the next one is refused. The count lives on the PC (`data/free-words.json`), because free dictation runs offline and there is nobody to ask. `FREE_WEEKLY_WORDS` on the account service sets the number, served in `/v1/me` so it can be retuned without an installer. Pro dictations are not counted at all, so a lapsed subscription starts Free with a full week.

## Proposed unlimited cloud economics

These estimates describe a future hosted Qwen + current-recognizer route, not the current single-recognizer runtime or measured profit. Prices last verified 11 September 2026:

| Provider route | List price |
| --- | ---: |
| Hosted Qwen3-ASR-1.7B on DeepInfra | USD 0.00045/minute = USD 0.027/hour |
| Current cloud recognizer on OpenRouter | USD 0.10/hour |

Sources: [DeepInfra Qwen](https://deepinfra.com/Qwen/Qwen3-ASR-1.7B) and the OpenRouter listing for the recognizer named in `server/cloud.js`.

The recognizer's price is a limited-time launch offer, not a long-term contract.

Illustrative assumptions:

- INR 100/USD as a round planning assumption, not a spot quote.
- 80% of audio duration initially routed to Qwen, 20% to the current recognizer. This is a scenario needing quality validation, not a demonstrated routing share.
- OpenRouter credit-purchase fee 5.5%, with top-ups large enough that the USD 0.80 minimum does not raise the effective percentage. [OpenRouter FAQ](https://openrouter.ai/docs/faq).
- A 10% inference buffer for retries and extra billed duration.
- INR 349 as a final customer total including an assumed 18% output GST for planning. Actual tax treatment and input credits depend on the business's circumstances.
- Payment processing modeled at 2% plus 18% GST on that fee, without assuming fee-tax input credits. [Razorpay pricing](https://razorpay.com/pricing/). Check the actual subscription and payment-method fees.
- INR 25 per paying user/month as an operating reserve.
- Excludes acquisition, salaries, refunds/chargebacks, income taxes, additional AI rewriting and unmodeled provider taxes/FX costs.

Blended inference cost = (0.8 × 2.70 + 0.2 × 10.55) × 1.10 = INR 4.697/audio hour.

Contribution = 349 / 1.18 − 349 × 0.0236 − 25 − audio hours × 4.697.

| Audio hours/user/month | Estimated inference | Estimated monthly contribution |
| ---: | ---: | ---: |
| 5 | INR 23.49 | INR 239.03 |
| 10 | INR 46.97 | INR 215.55 |
| 20 | INR 93.94 | INR 168.58 |
| 40 | INR 187.88 | INR 74.64 |
| 60 | INR 281.82 | −INR 19.30 |

At ten hours, contribution is about 73% of net-of-GST sales. It is not net profit. Per-user contribution breaks even near 56 hours under this model; that is an economic observation, not a product cap. Assess the full customer population including heavy users.

For 100% current-recognizer traffic at its launch price, modeled inference is INR 11.605/hour and contribution at ten hours is about INR 146.47. At the current 20-hour allowance, a subscriber who uses all of it still contributes about INR 30.43; contribution reaches zero near 22.6 hours (about 1,357 credits), so the cap keeps every subscriber above break-even while this price holds. The development relay measured USD 0.097 per billed hour across 451 requests on 11–13 September 2026, consistent with the list price. If 80/20 routing remains but the recognizer hypothetically rises to USD 0.36/hour, blended inference becomes INR 10.7316/hour and ten-hour contribution is about INR 155.20. This future rate is a stress-test assumption, not a prediction.

## Requirements before offering unlimited

1. Add a dedicated DeepInfra adapter to the authenticated relay. Provider keys stay on the server; cloud-only setup must not require a speech-model download.
2. Route Qwen only where held-out evaluation establishes acceptable quality and latency. Its published list includes Hindi and English but not every Indian language. Route only to a model supporting the selected language. Test Hinglish, accents, names, numbers and noise. [Official Qwen repository](https://github.com/QwenLM/Qwen3-ASR).
3. Prefer the current recognizer where it demonstrably improves results. Choose the first provider before inference where possible. If Qwen runs first and the current recognizer retries, both attempts cost money: a 20% retry rate differs from a 20% initial routing share.
4. Do not assume a calibrated confidence score exists. Validate routing signals using corrections, language support and failure patterns.
5. Meter unique user audio separately from provider attempts, including overlap, retries, warm-ups and billable failures. Voice-activity detection must preserve quiet speech and word boundaries.
6. Keep ordinary cleanup inexpensive. Budget additional LLM rewriting before including it.
7. Replace the fixed cloud cap with an explicit unlimited entitlement. Reserve any trial allowance atomically so parallel requests cannot bypass it.
8. Cloud-only subscribers need a working cloud fallback or a clear recoverable failure, not an attempt to run an uninstalled local model.

Suggested terms, only once implemented:

> Unlimited personal live dictation. No monthly word or hour limit. One active dictation session per account. Bulk file transcription, meeting recording services, automated/API usage and resale are not included.

Do not hide a fixed hours cap behind “fair use,” downgrade heavy users' accuracy to meet a cost target, or routinely transcribe every recording twice. Legitimate heavy professional and accessibility usage belongs within the personal dictation offer.

## Rollout

Start with monthly billing. Measure actual inference expense, usage distribution including heavy users, correction rates, P95 latency from India, support costs and refunds. A future cloud trial could include 30 minutes over seven days once per eligible account; it is not enabled today. The free on-device offering continues under the 3,000-word weekly cap described above; watch what share of free users reach it, and whether the number converts or simply drives uninstalls before changing it.

Do not add annual purchase controls, annual discounts or new annual payment-provider products until requested by the user. If revisited, use measured retention and costs to choose the price.
