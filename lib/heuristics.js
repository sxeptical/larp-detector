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

export function analyzeHeuristically({ post_text = '', author_headline = '' }) {
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
  const metrics = hit(t, /followers|connections|impressions|top voice|views|went viral|reach/);
  const announce = hit(t, /\bannounc(e|ing)\b|launching|excited to share/);

  const bait = hit(t, /agree\?|repost if|comment below|thoughts\?|drop a|tag someone|most people (won't|will ignore|don't)|here's why|let that sink in|read that again|resonates|which one/);
  const cliffhanger = hit(t, /(here'?s (what|how)|the (one )?thing|3 (words|lessons)|changed my life|changed everything)/);
  const secondPerson = countMatches(t, /\byou\b/g) >= 3 && !/\bi\b/.test(t.slice(0, 80));

  const mundane = hit(t, /coffee|barista|cab driver|uber driver|airport|taxi|waiter|my daughter|my son|my kid|grocery|lukewarm/);
  const lesson = hit(t, /taught me|lesson|realized|that'?s when i|reminder|takeaway|changed how i think/);
  const wisdomList = clamp01(hit(t, /here are \d+|lessons|takeaways|things i wish/) * 0.7 + bullets * 0.5);
  const philosopher = clamp01(mundane && lesson ? 1 : lesson && wisdomList > 0.5 ? 0.7 : 0);

  const grind = hit(t, /4 ?am|5 ?am|woke up at|days? (in a row|straight)|streak|grind|hustle|no days off|sacrific|missed my (kid|daughter|son)/);
  const failurePorn = hit(t, /i got (rejected|fired)|rejected me|fired me|failed. then|said no. then/);

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

  const aiShape = clamp01(
    0.4 * bullets +
    0.2 * (emojiCount >= 4 ? 1 : 0) +
    0.2 * hit(t, /here'?s what i learned|key takeaways|here are \d+|wish i (knew|had known) earlier|let me break it down/) +
    0.2 * (text.includes(':') && lineCount >= 6 ? 1 : 0)
  );
  let isAiWritten = clamp01(0.6 * aiShape + 0.25 * thrilled + 0.15 * bullets);
  // Canonical emoji-listicle slop shape — unmistakably machine-shaped
  if (bullets > 0.7 && emojiCount >= 4) isAiWritten = clamp01(isAiWritten + 0.25);

  // --- Scores ----------------------------------------------------------------
  const persona = clamp01(
    0.25 * philosopher + 0.25 * grind + 0.2 * metrics + 0.2 * (grandiose * (1 - specifics)) +
    0.1 * failurePorn + 0.15 * (thrilled || humblebrag)
  );
  const statFarming = clamp01(
    0.5 * bait + 0.3 * metrics + 0.3 * (cliffhanger ? 1 : 0) + 0.2 * announce
  );

  // --- Role choice -------------------------------------------------------------
  const roleScores = {
    philosopher: 1.5 * philosopher,
    tech_visionary: 1.4 * (grandiose * (1 - specifics)),
    influencer: 1.0 * ((metrics + thrilled + humblebrag) / 2) + 0.3 * announce,
    martyr: 1.4 * grind + 0.3 * failurePorn,
    bait: 1.3 * bait + 0.4 * (cliffhanger ? 1 : 0) + 0.3 * (secondPerson ? 1 : 0),
    other: 0.1,
    real_person: 0.9 * specifics + 0.5 * (1 - persona) - 0.4 * grandiose,
  };
  const sorted = Object.entries(roleScores).sort((a, b) => b[1] - a[1]);
  const sum = sorted.reduce((acc, [, v]) => acc + Math.max(0.02, v), 0);
  const probabilities = {};
  for (const [k, v] of sorted) probabilities[k] = Math.max(0.02, v) / sum;
  const [choice, choiceScore] = sorted[0];
  const confidence = clamp01(choiceScore / (sorted[1][1] + 0.001) / 4);

  // --- Intensity ----------------------------------------------------------------
  let intensity = 0;
  intensity += 1.6 * (grandiose * (1 - specifics)); // tech larp
  intensity += 1.3 * philosopher;
  intensity += 1.8 * grind;
  intensity += 1.0 * ((metrics + thrilled + humblebrag) / 2);
  intensity += 1.2 * bait;
  intensity += 0.5 * (cliffhanger ? 1 : 0);
  intensity += 1.0 * statFarming;
  intensity += 1.0 * isAiWritten;
  intensity -= 1.2 * specifics * (1 - grandiose); // receipts pull it down
  if (choice === 'real_person') intensity -= 0.8;
  if (choice === 'other') intensity -= 0.4;
  intensity = Math.max(0, Math.min(4, intensity));

  const levelProbs = {};
  for (let i = 0; i <= 4; i++) levelProbs[String(i)] = Math.max(0.02, 1 - Math.abs(i - intensity) * 0.6);
  const levelSum = Object.values(levelProbs).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(levelProbs)) levelProbs[k] /= levelSum;

  // --- Headline costume -----------------------------------------------------------
  const headlineLarp = clamp01(
    hit(h, /visionary|disruptor|thought leader|keynote|10x|top voice|futurist|guru|expert|ninja|wizard|evangelist/) * 0.8 +
    countMatches(h, /[|•]/g) * 0.15 +
    hit(h, /founder|ceo|building/) * 0.4
  );

  const n = (v) => ({ type: 'noul', noul: Number(clamp01(v).toFixed(3)) });
  return {
    answers: {
      persona_performance: n(persona),
      stat_farming: n(statFarming),
      grandiose_claims: n(grandiose),
      technical_specifics: n(specifics),
      headline_larp: n(headlineLarp),
      is_ai_written: n(isAiWritten),
      larp_role: { type: 'choice', choice, probabilities, confidence },
      larp_intensity: {
        type: 'score',
        score: Number(intensity.toFixed(2)),
        legend: {
          0: 'Receipts on the table: real work, real numbers, real context',
          1: 'Mostly real, light performative framing',
          2: 'Costume over substance: vague wisdom, unverifiable claims',
          3: 'Full character: humblebrag, grind mythology, or engineered bait',
          4: 'Peak LARP: fabricated parable, AI slop, shameless stat farming',
        },
        probabilities: levelProbs,
        confidence,
      },
    },
    model: 'heuristics-0.1',
    usage: { input_tokens: Math.round(text.length / 4), output_tokens: 0 },
  };
}
