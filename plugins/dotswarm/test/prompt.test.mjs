import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLeadPrompt, buildResumeSection, buildSteerPrompt, parseReport, suggestedRoles } from '../src/prompt.mjs';

test('design and refactor sections appear only when requested', () => {
  const base = { swarmId: 'sw-1', objective: 'Do X', maxAgents: 3, workspace: 'C:/ws' };
  const plain = buildLeadPrompt(base);
  assert.ok(!/UX AND DESIGN ITERATION/.test(plain));
  assert.ok(!/REFACTOR MODE/.test(plain));
  assert.ok(!/designer:/.test(plain));
  const design = buildLeadPrompt({ ...base, design: true, screensDir: 'C:/work/swarms/sw-1/screens' });
  assert.match(design, /UX AND DESIGN ITERATION/);
  assert.match(design, /390x844 and 1440x900/);
  assert.match(design, /C:\/work\/swarms\/sw-1\/screens/);
  assert.match(design, /read_image/);
  assert.match(design, /designer: render, screenshot/);
  const refactor = buildLeadPrompt({ ...base, mode: 'refactor' });
  assert.match(refactor, /REFACTOR MODE/);
  assert.match(refactor, /does not add features/);
  assert.match(refactor, /naming the audit id/);
});

test('resume section lists the old board, ledger size, and instruction', () => {
  const text = buildResumeSection({
    fromSwarmId: 'sw-old', tasks: [{ id: 'task-2', subject: 'Tests', status: 'in_progress', owner: 'tester' }],
    lastLeadMessage: 'half done', findingsCount: 12, instruction: 'finish tests',
  });
  assert.match(text, /RESUMING PREVIOUS SWARM sw-old/);
  assert.match(text, /12 entries/);
  assert.match(text, /- task-2 \[in_progress, was tester\] Tests/);
  assert.match(text, /half done/);
  assert.match(text, /finish tests/);
  assert.match(buildResumeSection({ fromSwarmId: 'x', tasks: [], findingsCount: 0 }), /had not created tasks/);
});

test('lead prompt explicitly requests Agent Teams and carries the protocol and report format', () => {
  const text = buildLeadPrompt({
    swarmId: 'sw-1', objective: 'Do X', plan: '1. a\n2. b', acceptanceCriteria: ['tests pass'],
    context: 'do not touch db', maxAgents: 3, workspace: 'C:/ws', isolated: true,
  });
  assert.match(text, /Use Agent Teams/);
  assert.match(text, /up to 3 teammates/);
  assert.match(text, /mcp__findings__record_finding/);
  assert.match(text, /## Handoff/);
  assert.match(text, /isolated git worktree/);
  assert.match(text, /do not touch db/);
  assert.match(text, /- tests pass/);
  assert.ok(!/\[Coordinator steer\]\n/.test(text));
  assert.ok(!/\bAstra\b/.test(text), 'the coordinator is not named');
});

test('steer prompt is framed and report parsing splits headings', () => {
  assert.match(buildSteerPrompt('stop editing db'), /^\[Coordinator steer\]\nstop editing db/);
  const report = parseReport('preamble\n## Summary\nok\n## Changes\n- a\n## Verification\nran\n## Unresolved\nNone\n## Handoff\nreview');
  assert.deepEqual(report, { summary: 'ok', changes: '- a', verification: 'ran', unresolved: 'None', handoff: 'review' });
  assert.equal(parseReport('no headings'), null);
  assert.equal(suggestedRoles(2).length, 2);
});

test('every multi-agent swarm gets a reviewer and the review standard', () => {
  assert.match(suggestedRoles(2)[1], /^reviewer:/);
  assert.match(suggestedRoles(3, { design: true })[2], /^designer:/);
  const prompt = buildLeadPrompt({ swarmId: 'sw-x', objective: 'Do it', maxAgents: 3, workspace: '/w', design: true });
  for (const needle of ['REVIEW STANDARD', 'QUALITY BAR', 'exits nonzero when it blocks', 'document.fonts.ready', 'fixed in the work by default', 'After the last edit of any kind', 'scope owner', 'cannot generate raster images']) {
    assert.ok(prompt.includes(needle), `lead prompt includes ${needle}`);
  }
});

test('brief and verify swarms get their own rules and roster', () => {
  const brief = buildLeadPrompt({ swarmId: 'sw-b', objective: 'Brief the site build', maxAgents: 3, workspace: '/w', mode: 'brief', briefPath: '/d/brief.md', briefWords: 8000, notesDir: '/d/notes' });
  assert.match(brief, /BRIEF MODE/);
  assert.match(brief, /at most 8000 words/);
  assert.match(brief, /\/d\/brief\.md/);
  assert.match(brief, /Quote verbatim/);
  assert.doesNotMatch(brief, /QUALITY BAR/);
  assert.match(suggestedRoles(3, { mode: 'brief' })[1], /^brief-checker:/);

  const verify = buildLeadPrompt({ swarmId: 'sw-v', objective: 'Verify the site', maxAgents: 3, workspace: '/w', mode: 'verify' });
  assert.match(verify, /VERIFY MODE/);
  assert.match(verify, /Never change judgment content/);
  assert.match(verify, /QUALITY BAR/);
  assert.match(suggestedRoles(3, { mode: 'verify' })[0], /^checker:/);
});
