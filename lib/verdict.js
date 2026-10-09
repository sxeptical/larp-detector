/**
 * Compose Jev's raw answers into a badge verdict.
 *
 * Two outcomes: REAL and LARP. The positive-evidence nouls (work shown vs
 * image crafted) form the persona gap; the costume-gap math (grandiose claims
 * vs technical specifics) and the unsupported-headline signal compound it.
 *
 * news_report is an EXEMPTION axis, not a LARP signal: a relayed report
 * imports its substance by design, so relief scales with it and damps the
 * persona gap, the costume gap, the borrowed-content bonus, and the raw
 * intensity. Relief decays with commentary dress (image_crafted, stat_farming,
 * virtue_performance) — substance-first: a news link wrapped in a take is
 * still judged as the take.
 *
 * Design rules (from the TypeSafe guidance):
 *  - Ask one sharp question per thing, then combine in code with weights we own.
 *  - Describe situations, not degrees.
 *  - Score is for thresholds/ranking, never for interpolation.
 *  - Thresholds are plain numbers in this file so they can be reviewed and tuned.
 */

import { LARP_LABELS, REQUIRED_NOULS } from './questions.js';

/**
 * Bump whenever the composition rules below change. The verdict cache stores
 * composed verdicts, not raw answers, so this is part of its key: without a
 * bump, posts judged under the old rules keep their old label.
 */
export const COMPOSER_VERSION = 2;

/** Show a LARP badge when effective intensity >= this. Slider in the popup. */
export const DEFAULT_SENSITIVITY = 1.5;

/** Below these, the post counts as genuine. */
const GENUINE_PERSONA_MAX = 0.35;
const GENUINE_SCORE_MAX = 1.25;

/** work_shown above this, with no persona or strong tell, is REAL outright. */
const RECEIPTS_MIN = 0.7;

/**
 * A LARP verdict the composer itself rates below this is a coin flip; hide it
 * rather than badge a post on a guess.
 */
const MIN_LARP_PCT = 50;

/** How strongly a relayed report pays down intensity (per unit of relief). */
const NEWS_RELIEF_PER_UNIT = 1.25;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Missing/unusable answers are an error state, not an invisible zero. */
function missingNouls(answers) {
  return REQUIRED_NOULS.filter((id) => typeof answers?.[id]?.noul !== 'number');
}

function noul(answers, id, fallback = 0) {
  const a = answers?.[id];
  return typeof a?.noul === 'number' ? a.noul : fallback;
}

/**
 * Score floors for the strong tells (applied outside MAX_BONUS). Set above the
 * default sensitivity so a clear bait or slop post shows a badge by default.
 */
const BAIT_FLOOR = 3;
const SLOP_FLOOR = 3;
const BAIT_AND_SLOP_FLOOR = 3.5;

/** Max total the composer may add on top of larp_intensity. */
const MAX_BONUS = 0.75;

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
  const newsReport = noul(answers, 'news_report');
  const villain = noul(answers, 'manufactured_villain');
  const humblebrag = noul(answers, 'humblebrag');
  const basking = noul(answers, 'basking');
  const isNarrative = noul(answers, 'is_narrative');
  const plainUpdate = noul(answers, 'plain_update');
  const sensitive = noul(answers, 'sensitive_context');
  const satire = noul(answers, 'is_satire');

  // larp_intensity already reflects bait, grind, fabrication, etc. The
  // composer's bonuses refine it but must not double-count it into a LARP.
  const base = answers.larp_intensity.score ?? 0;

  // --- News relief: relaying a report is not persona performance -------------
  // A wire share imports its substance by design, so the persona gap, the
  // borrowed-content bonus, and the costume gap misread it. Relief scales
  // with the relay signal and DECAYS as author commentary rides on the post
  // (self-focus, bait, moralizing) — substance-first: commentary re-opens
  // the persona lane and the post is judged on its own performance.
  // Self-focus: image_crafted plus its disguised forms. A humblebrag is image
  // crafting dressed as modesty; basking is image crafting by association,
  // and only counts when the author shows nothing they did themselves.
  const selfFocus = Math.max(imageCrafted, humblebrag, basking * (1 - workShown));
  const commentaryDress = Math.max(selfFocus, statFarming, virtuePerformance);
  const newsRelief = clamp01(newsReport * (1 - commentaryDress));
  if (newsRelief > 0.4) {
    details.push(
      `Relayed report (news signal ${pct(newsReport)}%) — persona and borrowed-substance signals damped ${pct(newsRelief)}%`
    );
  }

  let score = base;

  // --- Persona is the gap: image crafted without work shown ----------------
  // Positive-evidence questions compose more reliably than performance
  // detection: work_shown high pulls toward genuine, image_crafted high with
  // nothing to show pulls toward LARP. Relayed news gets full relief: the
  // author is not claiming the substance as their own.
  const imageGap = selfFocus * (1 - workShown) * (1 - newsRelief);
  const persona = Math.min(1, Math.max(imageGap * 1.1, selfFocus - 0.5 * workShown));

  // --- Tech-LARP composite: the costume gap --------------------------------
  // Magnitude claimed AND substance absent = the classic engineering LARP.
  // Relief applies here too: reported numbers are the article's claims, not
  // the sharer's costume.
  const costumeGap = grandiose * (1 - specifics) * (1 - newsRelief);
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
  // Only when the body has nothing to show: the headline describes the
  // person, not the post, so over real work it is annotated, never scored
  // (see the early-career note below).
  const headlineScored = workShown <= 0.5;
  if (headlineLarp > 0.7 && headlineScored) {
    score = Math.min(4, score + 0.3);
    details.push(`Headline costume detected (${pct(headlineLarp)}%)`);
  }

  // --- Headline claims unsupported by the post body — highest-signal tell ---
  const unsupportedHeadline = headlineLarp * (1 - headlineSupported);
  if (unsupportedHeadline > 0.5 && headlineScored) {
    score = Math.min(4, score + 0.4);
    details.push(
      `Headline not backed by the post (status ${pct(headlineLarp)}%, supported ${pct(headlineSupported)}%)`
    );
  }


  // --- Fabricated parable: vivid story, nothing checkable -------------------
  // LARP even with zero self-promotion — what is performed is experience the
  // author does not demonstrably have. Composes independently of the image
  // gap, which can be low for humblebrag-free fake stories.
  const fabrication = isNarrative * (1 - verifiableStory) * Math.max(1 - workShown, virtuePerformance, villain);
  if (fabrication > 0.6) {
    score = Math.min(4, score + 0.5);
    details.push(`Fabricated story signal (${pct(fabrication)}%): vivid but nothing checkable`);
  }

  // --- Borrowed applause: recycled content, quote-worship --------------------
  // The relief gate is the news carve-out: a relayed report is borrowed
  // substance by design, so only commentary-dressed relays pay this.
  if (borrowedContent > 0.7 && workShown < 0.5 && newsRelief < 0.5) {
    score = Math.min(4, score + 0.3);
    details.push(`Borrowed content (${pct(borrowedContent)}%) with nothing of the author added`);
  }

  // --- Disguised boast / borrowed status ------------------------------------
  if (humblebrag > 0.7) {
    score = Math.min(4, score + 0.3);
    details.push(`Humblebrag: boast disguised as modesty or complaint (${pct(humblebrag)}%)`);
  }
  if (basking * (1 - workShown) > 0.6) {
    score = Math.min(4, score + 0.3);
    details.push(`Status by association (${pct(basking)}%) with no work of the author's shown`);
  }

  // --- Virtue performance: goodness as content -------------------------------
  if (virtuePerformance > 0.7) {
    score = Math.min(4, score + 0.25);
    details.push(`Virtue signalling (${pct(virtuePerformance)}%)`);
  }

  // Cap the stacked bonuses so several overlapping signals can't turn a
  // mild post into a LARP on their own.
  score = Math.min(score, base + MAX_BONUS, 4);

  // --- Strong tells: engagement bait and AI slop ------------------------------
  // These are near-certain LARP on their own, so they set a FLOOR outside the
  // bonus cap instead of a capped nudge: larp_intensity is scoped to persona
  // and no longer reflects them. Exemptions below still apply (satire of bait,
  // a hardship post asking for referrals).
  const slop = aiWritten * (1 - workShown);
  let floor = 0;
  if (statFarming > 0.8) {
    floor = Math.max(floor, BAIT_FLOOR);
    details.push(`Engagement bait (${pct(statFarming)}%)`);
  } else if (statFarming > 0.6) {
    score = Math.min(4, score + 0.4);
    details.push(`Some engagement bait (${pct(statFarming)}%)`);
  }
  if (slop > 0.6) {
    floor = Math.max(floor, SLOP_FLOOR);
    details.push(`AI slop: generic writing with no work shown (${pct(slop)}%)`);
  } else if (aiWritten > 0.7 && workShown < 0.5) {
    score = Math.min(4, score + 0.3);
    details.push(`Template-like writing (${pct(aiWritten)}%)`);
  }
  if (statFarming > 0.8 && slop > 0.6) floor = Math.max(floor, BAIT_AND_SLOP_FLOOR);

  // --- Exemptions: plain updates, hardship, satire ----------------------------
  // Relief decays with commentary dress like the news relief: a job post
  // turned into a "here's what it taught me about leadership" lesson is
  // still judged as the lesson.
  const updateRelief = clamp01(plainUpdate * (1 - Math.max(selfFocus, statFarming)));
  const exemption = Math.max(updateRelief, sensitive, satire);
  if (exemption > 0.6) {
    const why = satire === exemption ? 'satire of LinkedIn culture' : sensitive === exemption ? 'hardship or request for help' : 'plain update';
    details.push(`Exempt: ${why} (${pct(exemption)}%)`);
    score = Math.max(0, score - 2 * exemption);
  }

  // --- News relief pays down intensity ---------------------------------------
  // Jev's intensity scale anchors "real work" on firsthand substance, which a
  // relayed report has none of — so the raw score overstates relayed news.
  // Relief strength already decays with commentary dress.
  score = Math.max(0, score - NEWS_RELIEF_PER_UNIT * newsRelief);

  // The strong-tell floor lands after the reliefs (a relay dressed in bait is
  // still bait) but yields to the exemptions above.
  if (exemption <= 0.6) score = Math.max(score, floor);

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

  // Receipts win: firsthand work with no persona, no strong tell, and no
  // fabricated story is REAL even when Jev's raw intensity runs warm.
  const receipts = workShown > RECEIPTS_MIN && persona < GENUINE_PERSONA_MAX && floor === 0 && fabrication <= 0.6;
  const isGenuine = (persona < GENUINE_PERSONA_MAX && score < GENUINE_SCORE_MAX) || exemption > 0.6 || receipts;
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
    // Without a distribution (heuristics, chat estimate) intensityTop is 0;
    // fall back to the score itself rather than halving every estimate.
    const certainty = hasProbs ? intensityTop : Math.min(1, score / 4);
    badgePct = pct(0.5 * Math.min(1, score / 4) + 0.5 * Math.max(persona, certainty));
    if (!hasProbs) badgePct = Math.min(95, badgePct); // an estimate never claims certainty
  }

  // --- Human-readable breakdown for the hover tooltip -------------------------
  details.unshift(`LARP intensity: ${score.toFixed(1)} / 4`);
  details.push(`Work shown: ${pct(workShown)}% · Image crafted: ${pct(imageCrafted)}%`);
  if (statFarming > 0.4 && statFarming <= 0.8) details.push(`Engagement bait: ${pct(statFarming)}%`);
  if (aiWritten > 0.5 && slop <= 0.6) details.push(`Generic phrasing signal: ${pct(aiWritten)}%`);
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
  if (typeof verdict.pct === 'number' && verdict.pct < MIN_LARP_PCT) return false;
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
