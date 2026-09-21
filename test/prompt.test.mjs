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
  assert.ok(!/\[Astra steer\]\n/.test(text));
});

test('steer prompt is framed and report parsing splits headings', () => {
  assert.match(buildSteerPrompt('stop editing db'), /^\[Astra steer\]\nstop editing db/);
  const report = parseReport('preamble\n## Summary\nok\n## Changes\n- a\n## Verification\nran\n## Unresolved\nNone\n## Handoff\nreview');
  assert.deepEqual(report, { summary: 'ok', changes: '- a', verification: 'ran', unresolved: 'None', handoff: 'review' });
  assert.equal(parseReport('no headings'), null);
  assert.equal(suggestedRoles(2).length, 2);
});
