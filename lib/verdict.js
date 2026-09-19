/**
 * Compose Jev's raw answers into a badge verdict.
 *
 * Two outcomes: REAL and LARP. The positive-evidence nouls (work shown vs
 * image crafted) form the persona gap; the costume-gap math (grandiose claims
 * vs technical specifics) and the unsupported-headline signal compound it.
 *
 * Design rules (from the TypeSafe guidance):
 *  - Ask one sharp question per thing, then combine in code with weights we own.
 *  - Describe situations, not degrees.
 *  - Score is for thresholds/ranking, never for interpolation.
 *  - Thresholds are plain numbers in this file so they can be reviewed and tuned.
 */

import { LARP_LABELS, REQUIRED_NOULS } from './questions.js';

/** Show a LARP badge when effective intensity >= this. Slider in the popup. */
export const DEFAULT_SENSITIVITY = 1.5;

/** Below these, the post counts as genuine. */
const GENUINE_PERSONA_MAX = 0.35;
const GENUINE_SCORE_MAX = 1.25;

/** Missing/unusable answers are an error state, not an invisible zero. */
function missingNouls(answers) {
  return REQUIRED_NOULS.filter((id) => typeof answers?.[id]?.noul !== 'number');
}

function noul(answers, id) {
  const a = answers?.[id];
  return typeof a?.noul === 'number' ? a.noul : 0;
}

function topProbability(probabilities) {
  if (!probabilities) return 0;
  return Math.max(0, ...Object.values(probabilities));
}

function pct(x) {
  return Math.round(100 * Math.max(0, Math.min(1, x)));
}

/** The badge for paid placements — no API call needed, the platform tells us. */
export function sponsoredVerdict() {
  const label = LARP_LABELS.sponsored;
  return {
    kind: 'sponsored',
    role: 'sponsored',
    label: label.label,
    color: label.color,
    pct: null,
    score: null,
    source: 'platform',
    model: null,
    details: ['Paid placement — no LARP analysis performed'],
  };
}

/**
 * @param {object} answers  Jev's `answers` object (or a heuristic stand-in with the same shape)
 * @param {object} meta     { model, usage, source }
 * @returns {object|null}   badge verdict, or null when the answers are unusable
 */
export function composeVerdict(answers, meta = {}) {
  const intensity = answers?.larp_intensity;
  if (!intensity || typeof intensity.score !== 'number' || Number.isNaN(intensity.score)) {
    console.warn('[LARP] missing or malformed larp_intensity score — answers unusable');
    return null;
  }

  const missing = missingNouls(answers);
  if (missing.length) {
    console.warn(`[LARP] answers missing required nouls: ${missing.join(', ')}`);
    return null;
  }

  const details = [];

  const workShown = noul(answers, 'work_shown');
  const imageCrafted = noul(answers, 'image_crafted');
  const statFarming = noul(answers, 'stat_farming');
  const grandiose = noul(answers, 'grandiose_claims');
  const specifics = noul(answers, 'technical_specifics');
  const headlineLarp = noul(answers, 'headline_larp');
  const headlineSupported = noul(answers, 'headline_supported');
  const aiWritten = noul(answers, 'is_ai_written');
  const verifiableStory = noul(answers, 'verifiable_story');
  const borrowedContent = noul(answers, 'borrowed_content');
  const virtuePerformance = noul(answers, 'virtue_performance');

  let score = answers.larp_intensity.score ?? 0;

  // --- Persona is the gap: image crafted without work shown ----------------
  // Positive-evidence questions compose more reliably than performance
  // detection: work_shown high pulls toward genuine, image_crafted high with
  // nothing to show pulls toward LARP.
  const imageGap = imageCrafted * (1 - workShown);
  const persona = Math.min(1, Math.max(imageGap * 1.1, imageCrafted - 0.5 * workShown));

  // --- Tech-LARP composite: the costume gap --------------------------------
  // Magnitude claimed AND substance absent = the classic engineering LARP.
  const costumeGap = grandiose * (1 - specifics);
  if (costumeGap > 0.55) {
    score = Math.min(4, score + 0.5);
    details.push(
      `Costume gap: grandiose claims ${pct(grandiose)}% vs technical specifics ${pct(specifics)}%`
    );
  } else if (grandiose > 0.5 && specifics > 0.5) {
    details.push(
      `Scale claim with receipts (grandiose ${pct(grandiose)}%, specifics ${pct(specifics)}%) — real work`
    );
  }

  // --- Headline costume compounds the verdict -------------------------------
  if (headlineLarp > 0.7) {
    score = Math.min(4, score + 0.3);
    details.push(`Headline costume detected (${pct(headlineLarp)}%)`);
  }

  // --- Headline claims unsupported by the post body — highest-signal tell ---
  const unsupportedHeadline = headlineLarp * (1 - headlineSupported);
  if (unsupportedHeadline > 0.5) {
    score = Math.min(4, score + 0.4);
    details.push(
      `Headline not backed by the post (status ${pct(headlineLarp)}%, supported ${pct(headlineSupported)}%)`
    );
  }

  // --- Stat farming nudges intensity up -------------------------------------
  if (statFarming > 0.8) score = Math.min(4, score + 0.2);

  // --- Fabricated parable: vivid story, nothing checkable -------------------
  // LARP even with zero self-promotion — what is performed is experience the
  // author does not demonstrably have. Composes independently of the image
  // gap, which can be low for humblebrag-free fake stories.
  const fabrication = (1 - verifiableStory) * Math.max(1 - workShown, virtuePerformance);
  if (fabrication > 0.6) {
    score = Math.min(4, score + 0.5);
    details.push(`Fabricated story signal (${pct(fabrication)}%): vivid but nothing checkable`);
  }

  // --- Borrowed applause: recycled content, quote-worship --------------------
  if (borrowedContent > 0.7 && workShown < 0.5) {
    score = Math.min(4, score + 0.3);
    details.push(`Borrowed content (${pct(borrowedContent)}%) with nothing of the author added`);
  }

  // --- Virtue performance: goodness as content -------------------------------
  if (virtuePerformance > 0.7) {
    score = Math.min(4, score + 0.25);
    details.push(`Virtue signalling (${pct(virtuePerformance)}%)`);
  }

  // --- Early-career earnestness: PG's inexperience exemption -----------------
  // A costume headline over a decent post is often a young founder imitating
  // the movements of people who run, not bad faith. Annotate instead of score
  // when the body shows work but the headline out-ranks it.
  if (headlineLarp > 0.7 && workShown > 0.5 && unsupportedHeadline > 0.3) {
    details.push('Costume headline over real work — could be early-career earnestness');
  }

  // --- Work shown is the receipts signal: pull intensity down ----------------
  if (workShown > 0.6 && imageGap < 0.3) {
    score = Math.max(0, score - 0.5);
  }

  const isGenuine = persona < GENUINE_PERSONA_MAX && score < GENUINE_SCORE_MAX;
  const kind = isGenuine ? 'genuine' : 'larp';
  const label = LARP_LABELS[kind];

  // --- Confidence shown on the badge ------------------------------------------
  const hasProbs = Boolean(answers.larp_intensity.probabilities && Object.keys(answers.larp_intensity.probabilities).length);
  const intensityTop = topProbability(answers.larp_intensity.probabilities);
  // Unusable responses (chat-estimate, heuristics) carry no probability
  // distribution; mark the verdict `estimated` instead of showing fabricated
  // certainty. The pct stays NUMERIC (renderer-gated on number) and the
  // uncertainty flag rides beside it.
  let badgePct;
  let estimated = !hasProbs;
  if (isGenuine) {
    badgePct = Math.min(95, pct(1 - persona));
  } else {
    badgePct = pct(0.5 * Math.min(1, score / 4) + 0.5 * Math.max(persona, intensityTop));
  }

  // --- Human-readable breakdown for the hover tooltip -------------------------
  details.unshift(`LARP intensity: ${score.toFixed(1)} / 4`);
  details.push(`Work shown: ${pct(workShown)}% · Image crafted: ${pct(imageCrafted)}%`);
  if (statFarming > 0.4) details.push(`Engagement bait: ${pct(statFarming)}%`);
  if (aiWritten > 0.5) details.push(`Generic phrasing signal: ${pct(aiWritten)}%`);
  details.push(
    `Source: ${meta.source === 'jev' ? (meta.model ?? 'Jev') : (meta.source ?? 'unknown')}${
      meta.usage?.input_tokens ? ` · ${meta.usage.input_tokens} tokens` : ''
    }`
  );
  if (estimated) details.push('Estimated confidence — no probability distribution behind this score');

  return {
    kind,
    role: kind,
    label: label.label,
    color: label.color,
    pct: badgePct,
    estimated, // true when the pct is an estimate (no probability distribution)
    score: Number(score.toFixed(2)),
    source: meta.source ?? 'unknown',
    model: meta.model ?? null,
    details,
  };
}

/**
 * Should the badge be shown, given user settings?
 * The raw verdict is always cached; this is applied at response time so
 * changing the slider re-filters without re-calling the API.
 */
export function shouldShow(verdict, settings) {
  if (!verdict) return false;
  if (verdict.kind === 'sponsored') return true;
  if (verdict.kind === 'genuine') return Boolean(settings.showGenuine);
  // Estimate-confidence verdicts (no probability distribution) must clear the
  // threshold by 0.25 to earn a badge — except heuristic verdicts, tagged
  // 'heuristic' (mock mode) or 'heuristic-fallback' (Jev call failed),
  // which would otherwise never show the very fabrication signals this
  // taxonomy added. Documented tradeoff: heuristic badges are noisier,
  // marked estimated in the tooltip.
  const bar = (verdict.estimated && !verdict.source?.startsWith('heuristic')
    ? (settings.sensitivity ?? DEFAULT_SENSITIVITY) + 0.25
    : (settings.sensitivity ?? DEFAULT_SENSITIVITY));
  return verdict.score >= bar;
}

/** Tooltip text for a rendered badge. */
export function tooltipFor(verdict) {
  if (verdict.kind === 'sponsored') return verdict.details.join('\n');
  return [`VERDICT: ${verdict.label}`, ...verdict.details].join('\n');
}
