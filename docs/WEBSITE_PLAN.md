# voxden.app — website plan

Status: built 2026-09-14 in `site/` (static HTML/CSS/JS, previewed with
`node scripts/preview-site.js`). Not yet deployed: needs the voxden.app domain
and a Cloudflare Pages project. See docs/SITE.md for the folder's own notes.

## 1. What the site is for

One product site at `voxden.app`, the domain the app already points at
(`account.voxden.app` is baked into `src/account.js`). It has four jobs, in
order of importance:

1. Get a Windows user from "what is this" to a downloaded installer, including
   the SmartScreen "More info → Run anyway" step, without them leaving.
2. Show the price plainly: ₹349 a month in India, $8 a month elsewhere, and
   what Pro adds over free.
3. Carry the legal pages the payment and sign-in reviews require: privacy
   policy, terms, refund policy, contact. Razorpay, Lemon Squeezy and Google
   OAuth verification each check for these at the product domain.
4. Be the place release notes live, so the in-app "What's new" and the GitHub
   release can link to one address.

Not a personal portfolio. Voxden is the brand every future product ships
under (memory: voxden-is-the-umbrella-business), so the site is Voxden's, and a
later product becomes a second section, not a second site.

## 2. Pages

| Path | Purpose | Notes |
|---|---|---|
| `/` | Home | Hero, how it works, accuracy/languages, Pro, download, FAQ |
| `/download` | Installer + SmartScreen steps | Direct link to the latest GitHub release asset; the bypass steps with real screenshots |
| `/pricing` | Free vs Pro | Regional price shown by a tiny script reading a `/cdn-cgi/trace` country hint or falling back to both prices side by side |
| `/changelog` | Release notes | Generated from `release-notes/*.md` at build time |
| `/privacy` | Privacy policy | From `PRIVACY.md`, same text the Google consent screen links to |
| `/terms` | Terms of use | New, short, plain |
| `/refunds` | Refund and cancellation policy | Razorpay and Lemon Squeezy both require it |
| `/contact` | Support | Discord invite, GitHub issues, support email |

Nothing else. No blog, no docs section, no login on the web.

## 3. Design: same room as the app

The app's look is dark, warm-black, one mint accent, gold reserved for Pro.
The site reuses the exact tokens rather than "inspired by" values.

**Colour**

| Token | Value | Use on the site |
|---|---|---|
| page background | `#0a0c0f` (titlebar) / `#0e0e10` (bg) | body |
| panel | `#161619`, `#1b1b1f` | cards, code blocks |
| border | `#26262b` | 1px hairlines only |
| text | `#ececef` | body copy |
| muted | `#8a8a92` / `#6a6a72` | secondary copy, labels |
| mint | `#9cf3c4` (strong `#83eaaf`, light `#adfbd1`) | the one accent: key words in headlines, primary button, dots, links |
| mint glow | `rgba(156,243,196,.08–.14)` radial from a corner | section backgrounds, same as the app's panels |
| gold | `#f1d27a → #d4a437` gradient, `#e8c15c` text | Pro badge, Pro card ring, nothing else |
| red | `#e07070` | never on marketing pages |

**Type.** Headlines in the app's product font stack (Segoe UI Variable Display,
falling back to system-ui) with tight tracking (−1.4px at 42px, −0.6px at 26px)
and weight 600. Body 15–16px, line-height 1.55. Eyebrow labels in 11px
letter-spaced caps, muted, like "LESS TYPING. MORE FLOW." on the dashboard.
Serif (Georgia) only for the one quote block on the home page, matching the
app's use of it.

**Shape.** 20px radius on large panels (the app's content inset), 12px on
cards, 8px on buttons and keycaps. Panels sit on a 1px `#26262b` border with a
faint mint radial from the top-left, plus the `surface-grain.svg` texture at
low opacity so surfaces don't read as flat CSS.

**Motion.** One reveal per section (opacity + 8px rise, 240ms, once). The hero
waveform pulses only while the cursor is over it, mirroring the flow bar rule
(memory: overlay-idle-animation-cost). No parallax, no floating blobs, no
gradient text sweeps.

**Imagery.** Real screenshots of the dashboard, flow bar and sign-in gate,
captured from the app at 2x, framed in the app's own panel style. The logo is
`assets/icon.png` / `logo.svg`, never redrawn.

**What keeps it from feeling generated.** Every section has a specific claim
with a number or a named thing (GPU Qwen3-ASR, 30-term phrase hints, Hinglish
transliteration, Ctrl+Win to dictate), not "supercharge your workflow". One
accent colour. No emoji. No three-column icon grids with a sentence each.
Buttons say what happens ("Download for Windows · 96 MB"). The FAQ answers the
awkward questions first: the SmartScreen warning, what leaves the PC, why it is
unsigned.

## 4. Home page, section by section

1. **Nav**: logo + "Voxden", links Download · Pricing · Changelog · Discord.
   Right side: "Download for Windows" mint button.
2. **Hero**: eyebrow "DICTATION FOR WINDOWS", headline "Your thoughts, in
   writing." with "in writing." in mint (the dashboard's own line), one
   sentence, the download button with size and version, and beneath it a
   keycap row "Ctrl + Win to dictate". Right: the flow bar screenshot mid
   dictation over a blurred editor.
3. **Proof strip**: three plain facts in a row, muted: works in every app ·
   runs on your GPU or in Voxden Cloud · Hinglish, Hindi and 90+ languages.
4. **How it works**: three numbered steps with real UI crops: press, speak,
   pasted. Short.
5. **Accuracy**: the dictionary and writing-style features. One screenshot of
   the dictionary page with phrase hints. Copy names the mechanism.
6. **Pro**: gold-ringed card, the seven Pro one-liners from the billing page,
   price by region, "Manage anytime, cancel at period end".
7. **Privacy**: what stays on the PC, what goes to the cloud only when Cloud
   is on, no audio kept unless you choose. Links to `/privacy`.
8. **FAQ**: SmartScreen warning, unsigned build, GPU needed?, offline use,
   refunds.
9. **Footer**: legal links, "Sounak Chakraborty, Barddhaman, India", Discord,
   GitHub.

## 5. Build

- Plain HTML and CSS in a new `site/` folder, one shared stylesheet, one
  small script for the price region and the FAQ toggles. No framework, no
  build step beyond a Node script that renders the changelog from
  `release-notes/` and stamps the latest version and installer size from the
  GitHub release API.
- Hosted on **Cloudflare Pages** from the repo (free, custom domain, HTTPS,
  edge cache). Deploy on push to `main` when `site/**` changes.
- `account.voxden.app` stays a separate A record to the VPS; the site never
  talks to the account service.
- Responsive: 1440 design width, breakpoints 1024 / 768 / 420, tested in the
  Browser pane at each.
- Accessibility: real headings, 4.5:1 contrast on all copy (mint on black
  passes; muted `#6a6a72` is for labels only), focus rings in mint.

## 6. Cost

| Item | Cost |
|---|---|
| `voxden.app` registration | ~₹1,200–1,800 / year (only recurring site cost) |
| Cloudflare Pages hosting, SSL, CDN | ₹0 |
| Mock-ups via Higgsfield (GPT Image 2) | a few credits, one time |

The VPS for the account service (~₹300–500 / month) is a separate, already
known cost and is not part of the site.

## 7. What only Sounak can do

1. Register `voxden.app` (Cloudflare Registrar is simplest since Pages lives
   there) and add me as the one who sets DNS, or paste the nameserver page.
2. Log the Higgsfield CLI in: `higgsfield auth login`.
3. Pick a support email to print on the site (or keep Discord only).
4. Approve the mock-ups before any HTML is written.

## 8. Sequence

1. Mock-ups (this step): GPT Image 2, three frames at 2K: home hero and first
   two sections on desktop, pricing page on desktop, home on a phone. Each is
   prompted from the token table above with `assets/icon.png` as the mark
   reference so the logo isn't invented.
2. Sounak reviews; one round of changes on the mock-ups, not on code.
3. Build `site/` to match, verify in the Browser pane at four widths and in
   both colour schemes (site is dark-only, but must not break under a light
   OS setting).
4. Cloudflare Pages project, custom domain, DNS.
5. Point the in-app links, README and the GitHub release at the new pages;
   swap the GitHub URLs in the Google consent screen and Razorpay ticket.
