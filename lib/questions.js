/**
 * The LARP taxonomy — the single source of truth.
 *
 * A post is LARP when its primary function is advancing the author's persona
 * rather than sharing substance: performing the character of visionary
 * executive / elite expert / thought leader instead of showing real work.
 *
 * Every question below is sent to Jev in ONE batched request per post
 * ("speculative fan-out"): questions are evaluated independently and in
 * parallel, so asking all of them costs only their own tokens and barely any
 * extra latency. See README.md for guidance on tuning the criteria — describe
 * SITUATIONS, not degrees.
 */

/** Badge identities. Two outcomes plus the platform-detected sponsored label. */
export const LARP_LABELS = {
  genuine: { label: 'REAL', color: 'green' },
  larp: { label: 'LARP', color: 'red' },
  sponsored: { label: 'SPONSORED', color: 'gold' },
};

/**
 * Build the question set for one post.
 * `post_text` and `author_headline` are the fields on the Jev `state` object.
 * The nouls and the score are judgment signals: they feed the composite score
 * that decides REAL vs LARP and powers the sensitivity threshold.
 */
export function buildQuestions() {
  return {
    // --- The core LARP axis -------------------------------------------------
    persona_performance: {
      type: 'noul',
      instructions:
        'Is the author of `post_text` performing a role — visionary executive, elite expert, or thought leader — rather than sharing real day-to-day work?',
    },
    stat_farming: {
      type: 'noul',
      instructions:
        'Is `post_text` primarily engineered to accumulate engagement metrics (likes, reposts, followers) rather than to communicate something specific?',
    },

    // --- The tech-LARP composite -------------------------------------------
    // The gap between these two (computed in code, in verdict.js) is the
    // definition of the Tech/Developer LARP: magnitude claimed, substance absent.
    grandiose_claims: {
      type: 'noul',
      instructions:
        'Does `post_text` claim impressive scale, speed, or magnitude (user counts, revenue, "built in a weekend", "billions of events")?',
    },
    technical_specifics: {
      type: 'noul',
      instructions:
        'Does `post_text` contain verifiable technical substance: architecture, constraints, methods, real numbers with context, code, or links to artifacts?',
    },

    // --- The costume: the author's headline ---------------------------------
    headline_larp: {
      type: 'noul',
      instructions:
        'Does `author_headline` claim visionary or elite status (e.g. "Visionary", "Disruptor", "Keynote Speaker", "10x", "Top Voice", "Thought Leader")?',
    },

    // --- Method: was the costume machine-made? ------------------------------
    is_ai_written: {
      type: 'noul',
      instructions:
        "Was `post_text` written by an AI assistant? Typical signs: 'I'm thrilled to announce', symmetrical emoji bullet lists, generic corporate cadence with no specifics.",
    },

    // --- How much LARP? ------------------------------------------------------
    larp_intensity: {
      type: 'score',
      instructions: 'How much LARP is in `post_text`?',
      criteria: [
        'Receipts on the table: real work, real numbers, real context',
        'Mostly real, light performative framing',
        'Costume over substance: vague wisdom, unverifiable claims',
        'Full character: humblebrag, grind mythology, or engineered bait',
        'Peak LARP: fabricated parable, AI slop, shameless stat farming',
      ],
    },
  };
}
