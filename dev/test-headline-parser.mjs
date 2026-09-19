/**
 * Tests the headline parser against line arrays sampled from the LIVE LinkedIn
 * feed (including cards polluted by our own badge text). The parser source is
 * extracted from content/content.js so this stays honest.
 *
 *   node dev/test-headline-parser.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'content/content.js'), 'utf8');

const start = src.indexOf('const RE_CHROME_LINE');
const end = src.indexOf('function isPromotedCard');
if (start === -1 || end === -1) throw new Error('parser source not found in content.js');
const parserCode = src.slice(start, end);
const { cardLines, extractHeadlineFromLines } = new Function(
  `${parserCode}; return { cardLines, extractHeadlineFromLines };`
)();

/** Run the full pipeline like content.js does: cardLines -> parser. */
const run = (lines, post) => extractHeadlineFromLines(cardLines({ innerText: lines.join('\n') }), post);

const CASES = [
  {
    name: 'standard person post',
    lines: ['Feed post', 'Suggested', 'Fathan Kartagama', '• 3rd+', 'Junior AI Developer | Specializing in Model Fine-Tuning', '2d', 'Follow', 'Indonesian-writing-skills: ...'],
    post: 'Indonesian-writing-skills: ...',
    expect: 'Junior AI Developer | Specializing in Model Fine-Tuning',
  },
  {
    name: 'social proof line',
    lines: ['Feed post', 'Esmond Low likes this', 'Xue Yi Fun', '• 2nd', 'Y2 Banking and Finance student | MILK Scholar', '1w', 'Follow', 'I don’t think I’ve...'],
    post: 'I don’t think I’ve ever walked away...',
    expect: 'Y2 Banking and Finance student | MILK Scholar',
  },
  {
    name: 'badge-polluted lines (new pill, label + pipe + pct)',
    lines: ['INFLUENCER | 33%', 'Feed post', 'Name', '• 2nd', 'Y2 Banking & Finance Student│ Ngee Ann Poly', '1w', 'Follow', 'CHAMPIONS!'],
    post: 'CHAMPIONS!',
    expect: 'Y2 Banking & Finance Student│ Ngee Ann Poly',
  },
  {
    name: 'badge-polluted lines (label + pct, no pipe)',
    lines: ['PHILOSOPHER 60%', 'Feed post', 'Suggested', 'Name', '• 3rd+', 'Venture Builder & Investor', '2d', 'Follow', 'Some post text right here.'],
    post: 'Some post text right here.',
    expect: 'Venture Builder & Investor',
  },
  {
    name: 'company post: no headline, body in the slot',
    lines: ['Feed post', 'Visual Studio Code', '2d', '🚀 The latest VS Code release brings new ways to ship.', 'Install the update today.'],
    post: '🚀 The latest VS Code release brings new ways to ship.\nInstall the update today.',
    expect: '',
  },
  {
    name: 'company post: 21h • Edited timestamp',
    lines: ['Feed post', 'Claude', '21h • Edited', 'Every hard rule in your CLAUDE.md file adds an extra step.', 'Run /doctor.'],
    post: 'Every hard rule in your CLAUDE.md file adds an extra step.\nRun /doctor.',
    expect: '',
  },
  {
    name: 'company post: body line equals headline slot exactly',
    lines: ['Feed post', 'Gaia', '1 billion monthly active users. 🚀', 'This week we crossed...'],
    post: '1 billion monthly active users. 🚀\nThis week we crossed...',
    expect: '',
  },
  {
    name: 'no headline, time directly after name',
    lines: ['Feed post', 'John Doe', '• 1st', '2d', 'Follow', 'Hello world post about something.'],
    post: 'Hello world post about something.',
    expect: '',
  },
  {
    name: 'body starting with headline-like words → rejected as ambiguous',
    lines: ['Feed post', 'Suggested', 'Jane Smith', '• 3rd+', 'Building in public', '5d', 'Follow', 'Building in public is scary.'],
    post: 'Building in public is scary.',
    expect: '',
  },
  {
    name: 'promoted card (has no headline)',
    lines: ['Feed post', 'Promoted', 'Acme Corp', 'Sponsored', 'Do things faster.', 'Learn more'],
    post: 'Do things faster.',
    expect: '',
  },
];

let failures = 0;
for (const c of CASES) {
  const got = run(c.lines, c.post);
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}`);
  if (!ok) console.log(`    expected: ${JSON.stringify(c.expect)}\n    got:      ${JSON.stringify(got)}`);
}

console.log(failures === 0 ? '\nAll parser cases passed.' : `\n${failures} case(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
