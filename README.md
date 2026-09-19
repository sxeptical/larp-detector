# LARP Detector for LinkedIn

A Chrome extension that detects LinkedIn LARP as you scroll.

**LARP** here means *identity performance*: playing the character of visionary
executive, elite expert, or thought leader instead of showing real work. The
extension judges each feed post with [Jev](https://typesafe.ai) — TypeSafe AI's
"System One" decision model — and drops a small status pill under the post:

| Badge | The character being played |
| --- | --- |
| `PHILOSOPHER` | Profound lessons from a lukewarm coffee |
| `10X ENGINEER` | "Scaled to 50M users in 3 weekends" (no architecture, no receipts) |
| `INFLUENCER` | Follower-count flexing, "grateful to announce", Top Voice |
| `MARTYR` | 4am alarms, streaks, suffering-as-virtue |
| `BAIT` | "Agree?", "Repost if", cliffhangers |
| `AI SLOP` | Machine-made costume: emoji listicles, hollow inspiration |
| `SPONSORED` | Paid placement (detected from the page, no API call) |
| `REAL ONE` | Receipts on the table (off by default) |

Each pill looks like `• INFLUENCER | 73%` — a colored dot (red for larp, green
for real, gold for sponsored) plus the label and confidence. Badges are
**transient**: they fade in under the post text, hold for about three seconds,
then fade out and remove themselves. Hover during the hold for the full
probability breakdown.

## Install

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder.
2. Click the crab icon in the toolbar → **Options**, paste a TypeSafe API key
   (join the waitlist at [typesafe.ai](https://typesafe.ai) — access clears in
   about a day), and hit **Test connection**.
3. Open LinkedIn, scroll, watch the pills appear. If a LinkedIn tab was already
   open when you installed, reload it first — Chrome doesn't inject into
   existing tabs.

No key yet? Set provider to **Mock** — the heuristics engine runs the whole
pipeline offline so you can develop and demo without the API. In mock mode,
enable "Also badge the REAL ONEs" in the popup to see every verdict.

## Providers

- **TypeSafe — Jev direct (recommended).** Jev itself: ~100ms per post,
  $0.042/M input tokens, output free.
- **OpenRouter — Jev via the alpha Decisions API.** Same model, same pricing,
  on an OpenRouter key. Jev does *not* speak the OpenAI-compatible chat
  endpoint — it only answers on the dedicated Decisions router
  (`POST /api/alpha/decisions`, request shape `{model, state, questions}`, same
  answers back), verified Sep 19, 2026. Alpha: may require access on your account.
- **OpenRouter — chat-model estimate.** Fallback for keys without Decisions
  access: a cheap structured-output chat model (default
  `deepseek/deepseek-v4-flash`) answers the same question set in JSON. Slower
  (1–3s per post) and output tokens are billed.
- **Mock.** Heuristics, no network — for development and demos.

## How it works

```
content/content.js        DOM only: MutationObserver + IntersectionObserver,
                          extracts visible posts, renders badges.
background/service-worker.js  Holds the API key, owns the request queue
                          (concurrency 3, retry/backoff), the persistent verdict
                          cache, and all provider calls.
lib/questions.js          The LARP taxonomy — one batched Jev request per post:
                          the core axis (persona_performance, stat_farming), the
                          tech-LARP composite (grandiose_claims vs
                          technical_specifics), headline_larp, is_ai_written,
                          the larp_role choice, and the larp_intensity scale.
lib/verdict.js            Composes answers into a badge. Owns the costume-gap
                          math: grandiose × (1 − specifics). Thresholds live here.
lib/heuristics.js         Regex fallback + mock mode. Same answer shape as Jev.
lib/jev-client.js         Provider adapter: typesafe (Jev direct) /
                          openrouter (Jev via OpenRouter's alpha Decisions
                          API) / openrouter-chat (structured-output chat-model
                          estimate) / mock. Retries 429/529 with backoff; guards
                          against model IDs leaking across providers.
ui/                       Popup (toggle, sensitivity slider) and Options
                          (key, provider, Test connection, clear cache).
```

Design decisions worth knowing:

- **One batched call per post** ("speculative fan-out"): every independent
  question is asked at once; the code decides which answers matter.
- **Cost is a rounding error**: ~$0.042 per million input tokens — a whole
  feed-scrolling session costs less than a cent.
- **Identity is `componentkey`, not `data-urn`** (LinkedIn dropped `data-urn`
  from feed posts in the 2026-09 UI; verified against the live DOM). Cards are
  re-rendered with new ids, so content-hash fallbacks keep verdicts attached.
- **Headlines are parsed from card text lines** — the current UI has no stable
  selector for the actor subtitle. `dev/test-headline-parser.mjs` tests the real
  parser against line arrays sampled from the live feed.
- **Badges are transient pills, placed in-flow.** They render under the post
  text (falling back to a floating pill when no anchor exists), hold ~3s, then
  fade out. `window.__larpBadgeVisibleMs` overrides the hold time in tests.
- **The key never touches the page.** It lives in `chrome.storage.local` and is
  only read by the service worker.

## Tuning the taxonomy

`lib/questions.js` is the product. Guidelines (from the TypeSafe docs):

1. **One judgment per question.** Split compound questions; compose in code.
2. **Describe situations, not degrees.** "Broken feature, workaround exists"
   beats "moderately severe".
3. **Give every Choice an escape hatch** (`other`), and phrase nouls so a high
   value means yes.
4. **Pin the model version** once you've tuned thresholds (`jev-1.13.0` instead
   of `jev-latest`) — set it in Options.
5. Test against labeled posts before trusting a threshold. The dev harness:

```bash
node dev/preview.mjs          # heuristics only, no key needed
TYPESAFE_API_KEY=... node dev/preview.mjs --live                    # through real Jev (direct)
OPENROUTER_API_KEY=... node dev/preview.mjs --live --openrouter     # through Jev via OpenRouter Decisions
OPENROUTER_API_KEY=... node dev/preview.mjs --live --openrouter-chat # through the chat-model estimate
node dev/smoke.mjs            # integration test: real service worker, mocked endpoints
node dev/test-headline-parser.mjs   # headline parser vs lines sampled from the live feed
```

Browser-test the content script on the real LinkedIn DOM (uses the
Browser Control CLI; needs a logged-in LinkedIn tab attached):

```bash
node dev/build-test-bundle.mjs                 # real content script + libs + chrome shim
browser-control execute --session <id> --file dev/linkedin-sweep.js
```

Edit the `SAMPLES` array in `dev/preview.mjs` — when you pre-label real feed
posts, label **the role being played**, not just larpy/not-larpy.

Regenerate icons after editing the crab:

```bash
python3 dev/make-icons.py
```

## Roadmap

- **Phase 2 — profile mode**: third-person "About" sections, Top Voice flexing,
  follower bragging (all Jev text signals). The black-and-white headshot can be
  a pixel-saturation check in the content script; "is that the Golden Gate
  Bridge" needs a vision model — Jev reads text only.
- **Feed polish**: shared/reposted post attribution, "see more" expansion before
  judging, per-post score history.

## Notes

- Read-only observation of posts already visible in your own feed; no clicking,
  liking, or scraping. Personal-use tool.
- Badges are judgments, not verdicts. The tooltip always shows the full
  probability breakdown so you can tell when Jev is unsure.
