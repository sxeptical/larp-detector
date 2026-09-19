/**
 * The LARP taxonomy — the single source of truth.
 *
 * A post is LARP when its primary function is advancing the author's persona
 * rather than sharing substance. Questions detect OBSERVABLE states, not
 * intent or persona archetypes: Jev judges what the text shows, and gaps
 * between questions (computed in verdict.js) form the verdict signals.
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
    // --- The core LARP axis: show work vs craft image ------------------------
    // Asked as positive evidence rather than performance detection: a judge
    // erring on these errs toward "genuine", hallucinating receipts is much
    // rarer than hallucinating a costume. The persona signal is the GAP
    // (image_crafted but no work shown), composed in verdict.js.
    work_shown: {
      type: 'noul',
      instructions:
        'Would a reader of `post_text` come away knowing something the author actually did, saw, or learned firsthand — a specific event, decision, artifact, or fact?',
    },
    image_crafted: {
      type: 'noul',
      instructions:
        'Is `post_text` primarily about the author\'s reputation, importance, or insightfulness, rather than about the specific thing that happened?',
    },

    // --- Engagement bait: the observable tell, not the intent ---------------
    stat_farming: {
      type: 'noul',
      instructions:
        'Does `post_text` contain explicit or implicit prompts for engagement: calls to agree, comment, share, or tag, rhetorical questions addressed to the reader with no informational answer, or references to the author\'s metrics?',
    },

    // --- The tech-LARP composite -------------------------------------------
    // The gap between these two (computed in code, in verdict.js) is the
    // definition of the Tech/Developer LARP: magnitude claimed, substance absent.
    grandiose_claims: {
      type: 'noul',
      instructions:
        'Does `post_text` claim impressive scale, speed, or magnitude — unsourced numbers, superlative attributions ("we shipped", "my team"), or inflated timelines ("built in a weekend")? Numbers that carry a source, name, or date do not count.',
    },
    technical_specifics: {
      type: 'noul',
      instructions:
        'Does `post_text` contain a detail that would be costly to invent: a specific causal mechanism, a concrete constraint and how it was resolved, or a checkable number in its real context? Keyword lists ("scalable", "AI-driven") do not count.',
    },

    // --- The costume: the author's headline ---------------------------------
    headline_larp: {
      type: 'noul',
      instructions:
        'Does `author_headline` assert status or authority rather than a plain role? A plain job title ("Backend Engineer at X") is not status; a rank ("Top Voice"), a self-bestowed adjective ("Visionary"), or a self-given title ("Keynote Speaker", "10x") is.',
    },

    // --- Cross-field signal: headline claims unsupported by the post ---------
    // The strongest LARP tell is inconsistency: a top-voice headline over a
    // post with zero substance. This is the one question that reads BOTH fields.
    headline_supported: {
      type: 'noul',
      instructions:
        'Is the status claimed in `author_headline` supported by anything in `post_text` — evidence, expertise, or concrete work that matches that status? Answer no when the headline asserts importance that the post does nothing to back up.',
    },

    // --- Method: is the writing generic? -------------------------------------
    // Phrased as what a text-only judge CAN measure (specificity of phrasing)
    // instead of unverifiable authorship attribution. Formatting tells (emoji
    // bullet lists) are better detected mechanically and are merged in code.
    is_ai_written: {
      type: 'noul',
      instructions:
        'Is the writing in `post_text` generic to the point it could have been written by anyone about anything — interchangeable corporate cadence, filler transitions, no names, no specifics, no voice?',
    },

    // --- How much LARP? ------------------------------------------------------
    larp_intensity: {
      type: 'score',
      instructions: 'How much LARP is in `post_text`?',
      criteria: [
        'Real work shown: specifics, numbers with context, artifacts, or a concrete firsthand account',
        'Real work, but dressed up: genuine content wrapped in announcement or self-promotion framing',
        'Costume over substance: vague wisdom or claims, nothing the author demonstrably did',
        'Full character: humblebrag, grind mythology, or engineered engagement bait',
        'Peak LARP: fabricated parable, AI slop, shameless stat farming',
      ],
    },
  };
}

/** Every noul the verdict composer expects to find in an answers object. */
export const REQUIRED_NOULS = [
  'work_shown',
  'image_crafted',
  'stat_farming',
  'grandiose_claims',
  'technical_specifics',
  'headline_larp',
  'headline_supported',
  'is_ai_written',
];
