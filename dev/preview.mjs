/**
 * Dev harness: run the heuristics → verdict pipeline over sample posts,
 * no browser and no API key needed.
 *
 *   node dev/preview.mjs            # heuristics only
 *   TYPESAFE_API_KEY=... node dev/preview.mjs --live   # hit the real Jev API
 *
 * The point is to sanity-check the taxonomy BEFORE loading the extension and
 * to see how verdict composition reacts to the answer shapes.
 */

import { analyzeHeuristically } from '../lib/heuristics.js';
import { composeVerdict, shouldShow } from '../lib/verdict.js';
import { callJev } from '../lib/jev-client.js';

const LIVE = process.argv.includes('--live');
const USE_OPENROUTER_CHAT = process.argv.includes('--openrouter-chat');
const USE_OPENROUTER = !USE_OPENROUTER_CHAT && process.argv.includes('--openrouter');
const PROVIDER = USE_OPENROUTER_CHAT ? 'openrouter-chat' : USE_OPENROUTER ? 'openrouter' : 'typesafe';
const settings = {
  provider: PROVIDER,
  apiKey: process.env.TYPESAFE_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  model: process.env.MODEL || '',
};
const hasLiveKey = PROVIDER.startsWith('openrouter')
  ? Boolean(settings.openrouterApiKey)
  : Boolean(settings.apiKey);

const SAMPLES = [
  {
    label: 'coffee parable',
    post_text:
      "I bought a lukewarm coffee this morning.\n\nThe barista looked at me and said: 'Sorry, the machine is slow today.'\n\nThat's when I realized — leadership is the same. Slow is not broken. Slow is brewing.\n\nAgree?",
    author_headline: 'Founder | Speaker | Coffee Enthusiast',
  },
  {
    label: 'tech larp',
    post_text:
      "We just scaled to 50 MILLION users in 3 weekends. My AI startup processed 2 billion events yesterday. Shipped 47 features this week. The team is unstoppable. 🚀",
    author_headline: 'Visionary Founder | Disruptor | Keynote Speaker | Top Voice',
  },
  {
    label: 'real engineer',
    post_text:
      "We shaved 400ms off our p99 checkout latency. Root cause: a postgres query doing a sequential scan on a table that grew past 40M rows. Fix was a compound index plus moving a pathological join into a materialized view. Benchmarks + the migration notes are in the repo: https://github.com/example/pr-218",
    author_headline: 'Staff Engineer at a logistics company',
  },
  {
    label: 'influencer flex',
    post_text:
      "I'm thrilled to announce I've crossed 100,000 followers on LinkedIn! 🎉\n\nWhen I started posting, I had 0.\n\nHere's what I learned:\n- Consistency is everything\n- Serve value before you ask\n- Engage with your community\n- Show up daily\n\nThank you all ❤️",
    author_headline: 'LinkedIn Top Voice | Content Creator | Mentor',
  },
  {
    label: 'grind martyr',
    post_text:
      "I woke up at 4am for the 400th day in a row. I missed my daughter's recital to close a deal. The grind doesn't care about your excuses. No days off. Hustle until it hurts. 💪",
    author_headline: 'CEO | Serial Entrepreneur | Author',
  },
  {
    label: 'bait',
    post_text:
      "Most people won't share this.\n\nBut I will.\n\nComment 'YES' below if you want the full breakdown. Repost if this resonated. Thoughts?",
    author_headline: 'Motivational Speaker',
  },
  {
    label: 'ai slop',
    post_text:
      "Leadership isn't about titles. It's about impact.\n\nHere are 5 lessons I wish I knew earlier:\n\n✅ Listen more than you speak\n✅ Hire slow, fire fast\n✅ Culture eats strategy\n✅ Feedback is a gift\n✅ Growth lives outside comfort\n\nWhich one resonates most? 👇",
    author_headline: 'Chief People Officer | Thought Leader',
  },
  {
    label: 'genuine celebration',
    post_text:
      "We shipped our first paid customer today. It's a €49/mo plan and we spent six weeks on the billing integration (Stripe tax in the EU is no joke). Numbers are still tiny but they're real. Thanks to everyone who tested the beta and filed the bug reports.",
    author_headline: 'Co-founder at a two-person startup',
  },
  {
    label: 'plain substance',
    post_text:
      "PSA: if you're on Postgres 15, check your autovacuum settings before any large backfill. We hit table bloat that took a weekend to unwind. Happy to share the playbook in comments.",
    author_headline: 'Database consultant',
  },
];

function pct(x) {
  return `${Math.round(x * 100)}%`.padStart(4);
}

async function runSample(sample) {
  if (LIVE && hasLiveKey) {
    try {
      const result = await callJev(
        { post_text: sample.post_text, author_headline: sample.author_headline },
        settings
      );
      const verdict = composeVerdict(result.answers, {
        model: result.model,
        usage: result.usage,
        source: 'jev',
      });
      return { verdict, raw: result.answers };
    } catch (err) {
      console.error(`[live] ${sample.label}: ${err.message}`);
      // fall through to heuristics
    }
  }
  const result = analyzeHeuristically(sample);
  const verdict = composeVerdict(result.answers, { model: result.model, source: 'heuristic' });
  return { verdict, raw: result.answers };
}

const showSettings = { sensitivity: 1.5, showGenuine: true };

let mismatches = 0;
for (const sample of SAMPLES) {
  const { verdict } = await runSample(sample);
  const shown = verdict && shouldShow(verdict, showSettings);
  const line = verdict
    ? `${verdict.label.padEnd(12)} ${String(verdict.pct ?? '–').padStart(3)}%  intensity ${verdict.score}`
    : 'no verdict';
  console.log(`${sample.label.padEnd(20)} ${shown ? ' ' : '(hidden) '} ${line}`);
  if (!verdict) mismatches++;
}

console.log(`\n${SAMPLES.length} samples, ${mismatches} unparseable.`);
if (LIVE && hasLiveKey) {
  console.log(`Ran against provider: ${PROVIDER}${settings.model ? ` (${settings.model})` : ''}.`);
} else {
  console.log(
    'Ran heuristics only. Pass --live with TYPESAFE_API_KEY (or OPENROUTER_API_KEY plus --openrouter / --openrouter-chat) to use a real model.'
  );
}
