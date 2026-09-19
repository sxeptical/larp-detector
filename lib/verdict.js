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
  if (!answers?.larp_intensity) return null;

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

  // --- Work shown is the receipts signal: pull intensity down ----------------
  if (workShown > 0.6 && imageGap < 0.3) {
    score = Math.max(0, score - 0.5);
  }

  const isGenuine = persona < GENUINE_PERSONA_MAX && score < GENUINE_SCORE_MAX;
  const kind = isGenuine ? 'genuine' : 'larp';
  const label = LARP_LABELS[kind];

  // --- Confidence shown on the badge ------------------------------------------
  const intensityTop = topProbability(answers.larp_intensity.probabilities);
  // Unusable responses (chat-estimate provider) carry no probabilities; cap
  // the display confidence there instead of showing fabricated certainty.
  let badgePct;
  if (isGenuine) {
    badgePct = Math.min(95, pct(1 - persona));
  } else {
    const base = pct(0.5 * Math.min(1, score / 4) + 0.5 * Math.max(persona, intensityTop));
    badgePct = answers.larp_intensity.probabilities && Object.keys(answers.larp_intensity.probabilities).length
      ? base
      : `~${base}`;
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

  return {
    kind,
    role: kind,
    label: label.label,
    color: label.color,
    pct: badgePct,
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
  // Unusable-confidence verdicts ("~" prefix) need to clear a raised bar:
  // estimates must beat the threshold by 0.25 to earn a badge.
  if (typeof verdict.pct === 'string') return verdict.score >= (settings.sensitivity ?? DEFAULT_SENSITIVITY) + 0.25;
  return verdict.score >= (settings.sensitivity ?? DEFAULT_SENSITIVITY);
}

/** Tooltip text for a rendered badge. */
export function tooltipFor(verdict) {
  if (verdict.kind === 'sponsored') return verdict.details.join('\n');
  return [`VERDICT: ${verdict.label}`, ...verdict.details].join('\n');
}
