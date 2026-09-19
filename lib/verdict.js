/**
 * Compose Jev's raw answers into a badge verdict.
 *
 * Design rules (from the TypeSafe guidance):
 *  - Ask one sharp question per thing, then combine in code with weights we own.
 *  - Score is for thresholds/ranking, never for interpolation.
 *  - Thresholds are plain numbers in this file so they can be reviewed and tuned.
 */

import { LARP_ROLES } from './questions.js';

/** Show a LARP badge when effective intensity >= this. Slider in the popup. */
export const DEFAULT_SENSITIVITY = 1.5;

/** Weighting for the headline prefix ("LARPING AS: ..."). */
const LABEL_PREFIX = 'LARPING AS';

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
  const role = LARP_ROLES.sponsored;
  return {
    kind: 'sponsored',
    role: 'sponsored',
    label: role.label,
    color: role.color,
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
  if (!answers || !answers.larp_role || !answers.larp_intensity) return null;

  const roleChoice = answers.larp_role.choice;
  if (!roleChoice || !LARP_ROLES[roleChoice]) return null;

  let labelRole = roleChoice;
  const details = [];

  const persona = noul(answers, 'persona_performance');
  const statFarming = noul(answers, 'stat_farming');
  const grandiose = noul(answers, 'grandiose_claims');
  const specifics = noul(answers, 'technical_specifics');
  const headlineLarp = noul(answers, 'headline_larp');
  const aiWritten = noul(answers, 'is_ai_written');

  const intensity = answers.larp_intensity.score ?? 0;
  let effectiveScore = intensity;

  // --- Tech-LARP composite: the costume gap --------------------------------
  // Magnitude claimed AND substance absent = the 10x-engineer LARP.
  const costumeGap = grandiose * (1 - specifics);
  if (costumeGap > 0.55 && labelRole !== 'real_person') {
    effectiveScore = Math.min(4, effectiveScore + 0.5);
    labelRole = 'tech_visionary';
    details.push(
      `Costume gap: grandiose claims ${pct(grandiose)}% vs technical specifics ${pct(specifics)}%`
    );
  } else if (grandiose > 0.5 && specifics > 0.5) {
    details.push(
      `Scale claim with receipts (grandiose ${pct(grandiose)}%, specifics ${pct(specifics)}%) — real engineering`
    );
  }

  // --- Headline costume compounds the verdict -------------------------------
  if (headlineLarp > 0.7 && labelRole !== 'real_person') {
    effectiveScore = Math.min(4, effectiveScore + 0.3);
    details.push(`Headline costume detected (${pct(headlineLarp)}%)`);
  }

  // --- Stat farming nudges intensity up -------------------------------------
  if (statFarming > 0.8 && labelRole !== 'real_person') {
    effectiveScore = Math.min(4, effectiveScore + 0.2);
  }

  // --- Machine-made costume gets its own badge -------------------------------
  if (aiWritten > 0.5 && aiWritten <= 0.9) {
    details.push(`AI-written signal ${pct(aiWritten)}%`);
  }
  if (aiWritten > 0.9 && labelRole !== 'real_person') {
    labelRole = 'ai_slop';
    details.push(`AI-written signal ${pct(aiWritten)}%`);
  }

  // --- The honest ones --------------------------------------------------------
  // Genuine is a claim about the post, so require the role answer to agree:
  // only an explicit `real_person` (or an unclassifiable post with no LARP
  // signal at all) earns the badge. A confident "martyr" never gets it.
  const isGenuine =
    labelRole === 'real_person' ||
    (roleChoice === 'other' && persona < 0.3 && effectiveScore < 1.0);
  if (isGenuine) labelRole = 'real_person';

  const role = LARP_ROLES[labelRole];

  // --- Confidence shown on the badge ------------------------------------------
  const roleProb =
    answers.larp_role.probabilities?.[labelRole] ??
    answers.larp_role.probabilities?.[roleChoice] ??
    answers.larp_role.confidence ??
    0;
  const intensityTop = topProbability(answers.larp_intensity.probabilities);
  let badgePct;
  if (isGenuine) {
    badgePct = Math.min(99, pct(1 - persona)); // confidence that this is not larp
  } else if (labelRole === 'ai_slop') {
    badgePct = pct(0.6 * aiWritten + 0.4 * Math.max(roleProb, intensityTop));
  } else {
    badgePct = pct(0.5 * roleProb + 0.5 * Math.min(1, effectiveScore / 4));
  }

  // --- Human-readable breakdown for the hover tooltip -------------------------
  details.unshift(`LARP intensity: ${effectiveScore.toFixed(1)} / 4`);
  details.push(`Persona performance: ${pct(persona)}%`);
  if (statFarming > 0.4) details.push(`Stat farming: ${pct(statFarming)}%`);
  if (answers.larp_role.probabilities) {
    const dist = Object.entries(answers.larp_role.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${pct(v)}%`)
      .join(' · ');
    details.push(`Role distribution: ${dist}`);
  }
  details.push(
    `Source: ${meta.source === 'jev' ? (meta.model ?? 'Jev') : (meta.source ?? 'unknown')}${
      meta.usage?.input_tokens ? ` · ${meta.usage.input_tokens} tokens` : ''
    }`
  );

  return {
    kind: isGenuine ? 'genuine' : 'larp',
    role: labelRole,
    label: role.label,
    color: role.color,
    pct: badgePct,
    score: Number(effectiveScore.toFixed(2)),
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
  return [`${LABEL_PREFIX}: ${verdict.label}`, ...verdict.details].join('\n');
}
