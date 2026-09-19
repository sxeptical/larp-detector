/**
 * Compose Jev's raw answers into a badge verdict.
 *
 * Two outcomes: REAL and LARP. The signal nouls and the intensity score feed
 * a composite; the costume-gap math (grandiose claims vs technical specifics)
 * and the headline costume nudge the score the same way they always did.
 *
 * Design rules (from the TypeSafe guidance):
 *  - Ask one sharp question per thing, then combine in code with weights we own.
 *  - Score is for thresholds/ranking, never for interpolation.
 *  - Thresholds are plain numbers in this file so they can be reviewed and tuned.
 */

import { LARP_LABELS } from './questions.js';

/** Show a LARP badge when effective intensity >= this. Slider in the popup. */
export const DEFAULT_SENSITIVITY = 1.5;

/** Below these, the post counts as genuine. */
const GENUINE_PERSONA_MAX = 0.35;
const GENUINE_SCORE_MAX = 1.25;

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
  if (!answers || !answers.larp_intensity) return null;

  const details = [];

  const persona = noul(answers, 'persona_performance');
  const statFarming = noul(answers, 'stat_farming');
  const grandiose = noul(answers, 'grandiose_claims');
  const specifics = noul(answers, 'technical_specifics');
  const headlineLarp = noul(answers, 'headline_larp');
  const aiWritten = noul(answers, 'is_ai_written');

  let score = answers.larp_intensity.score ?? 0;

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

  // --- Stat farming nudges intensity up -------------------------------------
  if (statFarming > 0.8) score = Math.min(4, score + 0.2);

  const isGenuine = persona < GENUINE_PERSONA_MAX && score < GENUINE_SCORE_MAX;
  const kind = isGenuine ? 'genuine' : 'larp';
  const label = LARP_LABELS[kind];

  // --- Confidence shown on the badge ------------------------------------------
  const intensityTop = topProbability(answers.larp_intensity.probabilities);
  const badgePct = isGenuine
    ? Math.min(99, pct(1 - persona))
    : pct(0.5 * Math.min(1, score / 4) + 0.5 * Math.max(persona, intensityTop));

  // --- Human-readable breakdown for the hover tooltip -------------------------
  details.unshift(`LARP intensity: ${score.toFixed(1)} / 4`);
  details.push(`Persona performance: ${pct(persona)}%`);
  if (statFarming > 0.4) details.push(`Stat farming: ${pct(statFarming)}%`);
  if (aiWritten > 0.5) details.push(`AI-written signal: ${pct(aiWritten)}%`);
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
  return verdict.score >= (settings.sensitivity ?? DEFAULT_SENSITIVITY);
}

/** Tooltip text for a rendered badge. */
export function tooltipFor(verdict) {
  if (verdict.kind === 'sponsored') return verdict.details.join('\n');
  return [`VERDICT: ${verdict.label}`, ...verdict.details].join('\n');
}
