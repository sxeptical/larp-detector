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

    // --- Fabrication axis: manufactured experience ---------------------------
    // LARP is not only self-promotion: a fabricated or unfalsifiable story is
    // LARP even with zero humblebrag, because what is performed is experience
    // the author does not demonstrably have. The r/LinkedInLunatics signature
    // is vivid specifics with nothing checkable.
    // Gate for verifiable_story: tips, opinions, and explainers are not
    // stories, and scoring them as "unverifiable stories" was the biggest
    // false-positive source. verdict.js only applies fabrication when this is high.
    is_narrative: {
      type: 'noul',
      instructions:
        'Does `post_text` tell a story — a sequence of events that happened to the author or someone they met (a conversation, an encounter, a turning point)? Advice, opinions, announcements, explanations, and news are not stories.',
    },
    verifiable_story: {
      type: 'noul',
      instructions:
        'If `post_text` tells a story, could its details in principle be checked — a date, place, name, company, artifact, or outcome someone else could confirm — rather than an unfalsifiable parable (vivid details, no anchors, no one and nothing to check)? If `post_text` does not tell a story, answer yes.',
    },

    // --- Borrowed applause: recycled stories and quote-worship ---------------
    borrowed_content: {
      type: 'noul',
      instructions:
        'Is the substance of `post_text` imported — a forwarded or reposted story, a famous person\'s quote framed as universal truth, a copied listicle — with no author-specific observation or insight added?',
    },

    // --- The news exemption: relaying a report is not persona performance ----
    // A shared news story imports its substance BY DESIGN, so the persona gap,
    // the borrowed-content bonus, and the costume gap all misread it (the
    // relief math lives in verdict.js). This question only measures the RELAY;
    // author commentary riding on the report is measured by the existing
    // nouls and re-opens the persona lane in the composer (substance-first).
    news_report: {
      type: 'noul',
      instructions:
        'Is the substance of `post_text` a relayed report about events in the world — a news story, article summary, filing, lawsuit, launch, hiring/layoff announcement, or another account of external facts the author is passing along — rather than the author\'s own experience or work? Attributed facts count ("Reuters reports…", "the filing shows…"); the author\'s own advice, lessons, or prompts to the reader do not.',
    },

    // --- Exemptions: ordinary posts that share LARP's surface -----------------
    // "Thrilled to announce" on a new job, a layoff post, a request for help:
    // they look like self-promotion to a costume detector but are just people
    // using LinkedIn for what it is for. Relief logic lives in verdict.js.
    plain_update: {
      type: 'noul',
      instructions:
        'Is `post_text` mainly a plain personal or professional update — a new job, promotion, graduation, certification, work anniversary, a launch, a hiring post, or a thank-you to specific people — stated without turning it into a lesson, a hero story, or a claim about the author\'s greatness?',
    },
    sensitive_context: {
      type: 'noul',
      instructions:
        'Is `post_text` about a hardship the author is going through — being laid off, looking for work, illness, grief, burnout, or a personal struggle — or a sincere request for help, referrals, or support?',
    },
    is_satire: {
      type: 'noul',
      instructions:
        'Is `post_text` clearly parody or satire of LinkedIn culture — mocking hustle posts, thought-leader clichés, or engagement bait — rather than a sincere example of them?',
    },

    // --- Virtue performance: goodness as content -----------------------------
    virtue_performance: {
      type: 'noul',
      instructions:
        'Does `post_text` dramatize the author\'s own goodness, generosity, or moral superiority primarily for audience approval — a kindness performed on camera, a manufactured villain, a public scolding framed as a lesson?',
    },

    // --- Engagement bait: the observable tell, not the intent ---------------
    stat_farming: {
      type: 'noul',
      instructions:
        'Does `post_text` end with or build toward engagement prompts aimed at boosting reach — "Agree?", "Repost if…", "Comment YES for the template", "Tag someone who…", or rhetorical questions with no real answer? A genuine question the author wants answered (asking for advice, recommendations, or feedback) does not count.',
    },

    // --- The tech-LARP composite -------------------------------------------
    // The gap between these two (computed in code, in verdict.js) is the
    // definition of the Tech/Developer LARP: magnitude claimed, substance absent.
    grandiose_claims: {
      type: 'noul',
      instructions:
        'Does `post_text` claim impressive scale, speed, or magnitude that the post does not back up — unsourced big numbers ("millions of users", "10x revenue") or implausible timelines ("built a unicorn in a weekend")? Plainly stated team work ("we shipped X") and numbers that carry a source, name, date, or context do not count.',
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
        'Is the status claimed in `author_headline` supported by anything in `post_text` — evidence, expertise, or concrete work that matches that status? Answer no when the headline asserts importance that the post does nothing to back up. If `author_headline` is empty or is a plain role with no status claim, answer yes.',
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
  // Fabrication / attribution / virtue axes (see research notes in the PR)
  'verifiable_story',
  'borrowed_content',
  'virtue_performance',
  // The news-relay exemption axis
  'news_report',
];
