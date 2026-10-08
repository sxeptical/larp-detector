/**
 * Heuristic LARP analysis.
 *
 * Two jobs:
 *   1. Mock mode — develop and demo the whole extension with no API key.
 *   2. Fallback — if the Jev call fails, badges still work (marked as heuristic).
 *
 * It returns an answers object with the SAME shape as Jev's, so verdict.js
 * composes it identically. It is deliberately regex-simple: it only needs to
 * be directionally right, not calibrated.
 *
 * NOTE: keep this file dependency-free — the content script dynamic-imports it.
 */

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function hit(text, regex) {
  return regex.test(text) ? 1 : 0;
}

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/** Lines that start with an emoji or bullet — the classic AI slop list shape. */
function bulletLineRatio(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return 0;
  const bullets = lines.filter((l) =>
    /^([-•*✓✔➡➤👉]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u.test(l)
  ).length;
  return clamp01((bullets / lines.length) * 2.5);
}

export function analyzeHeuristically({ post_text = '', author_headline = '', media = '' }) {
  const text = String(post_text);
  const headline = String(author_headline);
  const t = text.toLowerCase();
  const h = headline.toLowerCase();
  if (!text.trim()) return null;

  const emojiCount = countMatches(text, EMOJI_RE);
  const bullets = bulletLineRatio(text);
  const lineCount = text.split('\n').filter(Boolean).length;

  // --- Raw signals (each roughly 0..1) --------------------------------------
  const thrilled = hit(t, /thrilled to announce|humbled to (share|announce)|beyond (excited|humbled)|grateful to (share|announce)|incredibly proud/);
  const humblebrag = hit(t, /so humbled|humbled to|pinch me|still (can't|cannot) believe|what an honor/);
  // Complaint-based humblebrag: hardship whose content is the achievement.
  const complaintBrag = hit(t, /(so |completely )?(exhausted|tired|jet-?lagged|drained) (from|after) (all )?(the |my )?(\w+ )?(keynotes?|talks|speaking|interviews|offers|panels|launch(es)?|flights?|conferences?)|(too many|so many) (offers|invitations|speaking requests|inbound)|(picked|chose|selected) me over/);
  const basking = clamp01(
    0.6 * hit(t, /(lunch|coffee|dinner|chat|met|sat down|shared the stage|on stage|panel) with (the )?(ceo|founder|cto|president|legendary|famous)\b|\b(ceo|founder) of (google|apple|microsoft|amazon|meta|openai|nvidia|tesla)/) +
    0.5 * hit(t, /my (time|years|days) at (google|apple|microsoft|amazon|meta|openai|mckinsey|bain|bcg|goldman|harvard|stanford|mit|yc|y combinator)|(as an? |former )(googler|mckinsey|harvard|stanford|yc)\b/)
  );
  const metrics = hit(t, /followers|connections|impressions|top voice|views|went viral|reach/);
  const announce = hit(t, /\bannounc(e|ing)\b|launching|excited to share/);

  const bait = hit(t, /agree\?|repost if|comment below|thoughts\?|drop a|tag someone|most people (won't|will ignore|don't)|here's why|let that sink in|read that again|resonates|which one/);
  const cliffhanger = hit(t, /(here'?s (what|how)|the (one )?thing|3 (words|lessons)|changed my life|changed everything)/);

  const mundane = hit(t, /coffee|barista|cab driver|uber driver|airport|taxi|waiter|my daughter|my son|my kid|grocery|lukewarm/);
  const lesson = hit(t, /taught me|lesson|realized|that'?s when i|reminder|takeaway|changed how i think/);
  const wisdomList = clamp01(hit(t, /here are \d+|lessons|takeaways|things i wish/) * 0.7 + bullets * 0.5);

  const grind = hit(t, /4 ?am|5 ?am|woke up at|days? (in a row|straight)|streak|grind|hustle|no days off|sacrific|missed my (kid|daughter|son)/);

  const scaleWords = countMatches(t, /billions?|millions?|10x|100x|thousands of|scaled|scale[d]? to|users|mrr|arr/g);
  const grandiose = clamp01(
    scaleWords * 0.3 +
    (hit(t, /in (just )?\d+ (hours?|days?|weekends?|weeks?)/) ? 0.4 : 0) +
    (hit(t, /\bi (built|shipped|grew|scaled)/) ? 0.3 : 0)
  );

  const specifics = clamp01(
    0.7 * hit(t, /github\.com|https?:\/\/|we open[- ]sourced|architecture|latency|p99|postgres|redis|kafka|kubernetes|benchmark|profiler|unit test|pull request|the bug was|root cause/) +
    0.3 * hit(t, /\b\d+(\.\d+)?\s?(ms|rps|qps|tb|gb|milliseconds|requests|queries)\b/)
  );

  // --- Work shown vs image crafted (the two core nouls) ---------------------
  // work_shown = concrete firsthand substance; image_crafted = performance.
  const workShown = clamp01(
    0.7 * specifics +
    0.3 * hit(t, /\b(i|we) (built|shipped|launched|fixed|tested|measured|wrote|interviewed)\b/)
  );
  const announceOrBrag = clamp01(
    0.5 * thrilled + 0.3 * announce + 0.4 * (metrics || humblebrag ? 1 : 0)
  );
  const imageCrafted = clamp01(
    0.5 * Math.max(announceOrBrag, wisdomList, mundane, bait, cliffhanger, lesson, hit(t, /believe in (people|yourself)|faith in humanity|be kind|be the change/i)) +
    0.3 * (thrilled || humblebrag) +
    0.2 * announce
  );

  const aiShape = clamp01(
    0.4 * bullets +
    0.2 * (emojiCount >= 4 ? 1 : 0) +
    0.2 * hit(t, /here'?s what i learned|key takeaways|here are \d+|wish i (knew|had known) earlier|let me break it down/) +
    0.2 * (text.includes(':') && lineCount >= 6 ? 1 : 0)
  );
  let isAiWritten = clamp01(0.6 * aiShape + 0.25 * thrilled + 0.15 * bullets);
  // Canonical emoji-listicle slop shape — unmistakably machine-shaped
  if (bullets > 0.7 && emojiCount >= 4) isAiWritten = clamp01(isAiWritten + 0.25);

  // --- Headline costume -----------------------------------------------------
  const headlineLarp = clamp01(
    hit(h, /visionary|disruptor|thought leader|keynote|10x|top voice|futurist|guru|expert|ninja|wizard|evangelist/) * 0.8 +
    countMatches(h, /[|•]/g) * 0.15 +
    hit(h, /founder|ceo|building/) * 0.4
  );

  // headline_supported = does the body carry substance matching a statusy
  // headline? Receipts support; announce-framing is a costume tell, not
  // evidence, and length alone supports nothing — both pull DOWN.
  const headlineSupported = clamp01(
    0.6 * workShown +
    0.2 * specifics -
    0.2 * (announce ? 1 : 0)
  );

  // --- Fabrication / borrowed / virtue axes (regex stand-ins) ----------------
  // verifiable_story: anchors the reader could check (fake-parable tell is
  // vivid + unanchored). borrowed_content: quotes/reposts/listicles.
  // virtue_performance: performed goodness (tips, kindness, moral lessons).
  const storyAnchors = countMatches(t, /\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|https?:\/\/|@\w+|\$\d|last (week|month|year)|yesterday|this morning|yesterday i|at \w+( airport| hotel| office)/g);
  const storyVividness = clamp01(
    0.4 * mundane +
    0.3 * (lineCount >= 8 ? 1 : 0) +
    0.3 * hit(t, /\bstory\b|when i was|years ago|once (asked|told|said)|everyone clapped|faith in humanity|believe in people|that's (it\.|the lesson)/i)
  );
  const verifiableStory = clamp01(
    0.5 * Math.min(1, storyAnchors / 2) + 0.5 * specifics
  );
  const quoteWorship = hit(t, /as \w+ (once )?said|quote[sd]?|wisdom from|\bEinstein\b|\bMusk\b|\bJobs\b|\bGandhi\b|\bNaval\b|\bPaul Graham\b|steal like|keys to success|read that again/i);
  const repostTell = hit(t, /repost(?:ed|ing)?|re-?shared|h\/t|credit:|(go )?follow \w+|^\w+['’]s post/i);
  const borrowedContent = clamp01(0.6 * quoteWorship + 0.5 * repostTell + 0.2 * (bullets > 0.5 && wisdomList > 0.5 ? 1 : 0));
  const virtueSignal = hit(t, /paid for|covered the (bill|tip)|gave (my|the) (tip|seat|umbrella)|handed|homeless|single (mom|mother)|stood up for|kindness|proud of (him|her|them)|believe in people|humanity/i);
  const moralScold = hit(t, /shame|disgusting|unacceptable|wrong with people|do better|be better|this needs to stop/i);
  const virtuePerformance = clamp01(0.7 * virtueSignal + 0.4 * moralScold);
  const villain = hit(t, /\b(my|a|the) (boss|manager|recruiter|interviewer|hiring manager|ceo|client|professor|teacher)\b[^.\n]{0,60}\b(told|said|laughed|rejected|asked|mocked|refused)/i);

  // --- News relay axis (the exemption signal) --------------------------------
  // Directional stand-in for news_report: outlets, attribution phrases, and
  // filing/event vocabulary. Jev reads the actual relay-vs-commentary split;
  // this only has to find the obvious wire shares. Commentary dress (bait,
  // metrics, moralizing) is NOT subtracted here — verdict.js decays the
  // relief with it, so over-triggering is safe.
  const newsOutlet = hit(t, /\b(reuters|bloomberg|associated press|cnbc|cnn|bbc|npr|politico|axios|semafor|the verge|techcrunch|wired|ars technica|engadget|wall street journal|wsj|new york times|nytimes|financial times|the guardian|washington post|forbes|fortune|business insider|marketwatch|barron'?s|economist|linkedin news)\b/);
  const newsAttribution = hit(t, /according to|reported by|reportedly|press release|sec filing|the filing (shows|says)|earnings (call|report)|breaking:|just in:|in a statement|reports? (say|says|said|emerged)|wire report|spokesperson said|announced on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  const newsEvents = hit(t, /\b(lawsuit|sued|acquired|acquisition|ipo|went public|layoffs|laid off|bankruptcy|merger|outage|data breach|recall(ed|s)?|antitrust|regulator|sanctioned|fined)\b/);
  // A link preview to an outlet's domain is relay evidence too.
  const newsLink = hit(String(media).toLowerCase(), /link: [^.]*\b(reuters|bloomberg|apnews|cnbc|cnn|bbc|npr|politico|axios|semafor|theverge|techcrunch|wired|arstechnica|engadget|wsj|nytimes|ft|theguardian|washingtonpost|forbes|fortune|businessinsider|marketwatch|barrons|economist)\.(com|co\.uk|org)/);
  const newsReport = clamp01(0.7 * (newsOutlet || newsAttribution || newsLink ? 1 : 0) + 0.25 * newsEvents);

  // --- Exemption axes (regex stand-ins) ---------------------------------------
  const isNarrative = clamp01(Math.max(storyVividness, 0.6 * hit(t, /\b(i|we) (met|asked|told|saw|was sitting|walked)|\bhe said|\bshe said|they said/)));
  const plainUpdate = hit(t, /(started|starting) a new position|new (role|job|position) (at|as)|i'?ve (joined|accepted)|promoted to|graduated|certified|certification|work anniversary|we'?re hiring|now hiring|thank you to|thanks to (my|the|everyone)/);
  const sensitive = hit(t, /laid off|lost my job|open to work|looking for (work|a new role|opportunities)|job search|referral|diagnos|passed away|grief|burn(ed|t)? ?out|mental health|any leads/);
  const satire = hit(t, /\b(satire|parody|\/s\b)|#linkedinlunatics/);

  const n = (v) => ({ type: 'noul', noul: Number(clamp01(v).toFixed(3)) });
  return {
    answers: {
      work_shown: n(workShown),
      // "Thrilled to announce" on a plain update is convention, not costume.
      image_crafted: n(plainUpdate ? imageCrafted * 0.4 : imageCrafted),
      stat_farming: n(clamp01(0.5 * bait + 0.3 * metrics + 0.3 * (cliffhanger ? 1 : 0) + 0.2 * announce)),
      grandiose_claims: n(grandiose),
      technical_specifics: n(specifics),
      headline_larp: n(headlineLarp),
      headline_supported: n(headlineSupported),
      is_ai_written: n(isAiWritten),
      verifiable_story: n(verifiableStory),
      borrowed_content: n(borrowedContent),
      virtue_performance: n(virtuePerformance),
      news_report: n(newsReport),
      is_narrative: n(isNarrative),
      plain_update: n(plainUpdate),
      sensitive_context: n(sensitive),
      is_satire: n(satire),
      manufactured_villain: n(villain),
      humblebrag: n(Math.max(complaintBrag, plainUpdate ? 0 : 0.8 * humblebrag)),
      basking: n(basking),
      larp_intensity: {
        type: 'score',
        score: Number(intensityFor({
          grandiose, specifics, grind, wisdomList, bait, cliffhanger,
          metrics, thrilled, humblebrag, announce, isAiWritten, workShown, imageCrafted,
          verifiableStory, borrowedContent, virtuePerformance, mundane, storyVividness,
          newsReport,
        }).toFixed(2)),
        // Mirrors INTENSITY_CRITERIA in questions.js (inlined: no imports here).
        legend: {
          0: 'Real work shown: specifics, numbers with context, artifacts, or a concrete firsthand account',
          1: 'Real work, but dressed up: genuine content wrapped in announcement or self-promotion framing',
          2: 'Costume over substance: vague wisdom or claims, nothing the author demonstrably did',
          3: "Persona as the point: the post exists to project the author's image — humblebrag, grind mythology, hero story",
          4: "Pure performance: no substance at all, only the author's image",
        },
        probabilities: {},
        confidence: 0,
      },
    },
    model: 'heuristics-0.2',
    usage: { input_tokens: Math.round(text.length / 4), output_tokens: 0 },
  };
}

/**
 * Intensity composite. Receipts (work_shown with no crafted image) pull it
 * down; costume gaps, grind mythology, and bait push it up. Returned as a raw
 * number in [0, 4]; the score-shape wrapper happens in analyzeHeuristically.
 */
function intensityFor({
  grandiose, specifics, grind, wisdomList, bait, cliffhanger,
  metrics, thrilled, humblebrag, announce, isAiWritten, workShown, imageCrafted,
  verifiableStory, borrowedContent, virtuePerformance, mundane, storyVividness,
  newsReport,
}) {
  const imageGap = imageCrafted * (1 - workShown);
  let intensity = 0;
  intensity += 1.6 * (grandiose * (1 - specifics)); // tech larp
  intensity += 1.3 * wisdomList;
  intensity += 1.8 * grind;
  intensity += 1.0 * ((metrics + thrilled + humblebrag) / 2);
  intensity += 1.2 * bait;
  intensity += 0.5 * (cliffhanger ? 1 : 0);
  intensity += 1.0 * imageGap;
  intensity += 1.0 * isAiWritten;
  // Fabrication / borrowed / virtue axes: story is vivid but nothing can be
  // checked; applause imported with nothing of the author added. The vividness
  // multiplier is the fabricated-parable shape itself (mundane setup, long
  // narrative, "when I was"), not the clifftell bait proxy.
  intensity += 1.2 * (1 - verifiableStory) * Math.max(storyVividness, 0.25);
  intensity += 1.0 * borrowedContent * (1 - workShown);
  intensity += 0.8 * virtuePerformance;
  // News relief: a relayed report is persona-neutral. The commentary-dress
  // decay mirrors verdict.js — bait/metrics on the relay re-open the lane.
  intensity -= 1.3 * newsReport * (1 - Math.max(imageCrafted, bait, virtuePerformance));
  intensity -= 1.2 * specifics * (1 - grandiose); // receipts pull it down
  intensity -= 0.8 * workShown * (1 - imageCrafted); // plain real work
  return Math.max(0, Math.min(4, intensity));
}
