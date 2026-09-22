// The coordinator's view of a finished swarm: what is still open, where to look first,
// and a handoff file the next stage can start from in a fresh session. Everything here
// is pure so it can be tested without a runtime.

const MESSAGE_CAP = 300;
const FILE_CAP = 80;

/** Files whose defects are costly and easy to miss in review: gates, build config, schema, forms, auth, secrets. */
const RISK_PATTERNS = [
  /(^|\/)package\.json$/, /(^|\/)scripts\//, /release|deploy|publish|gate|guard|policy/i,
  /schema|json-?ld|seo/i, /form|contact|input|consent/i, /auth|session|token|secret|credential|\.env/i,
  /(^|\/)(astro|vite|next|tsconfig|wrangler|netlify|vercel)[^/]*\.(m?[jt]s|json|toml)$/i,
];

const NOTES = /\.(md|mdx|txt)$/i;
const RANGE_LIMIT = 200;

const compact = (f) => `${f.id} [${f.type}] ${f.scope}: ${f.message.slice(0, MESSAGE_CAP)}`;

/** Finding numbers a message names, including ranges such as F-013..F-020 or F-005 to F-030. */
export function referencedIds(message) {
  const ids = new Set();
  for (const m of message.matchAll(/F-(\d+)\s*(?:\.\.\.?|–|—|to|-)\s*F-(\d+)/g)) {
    const [lo, hi] = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
    if (hi - lo <= RANGE_LIMIT) for (let n = lo; n <= hi; n += 1) ids.add(n);
  }
  for (const m of message.matchAll(/F-(\d+)/g)) ids.add(Number(m[1]));
  return ids;
}

/**
 * Split warnings and failures into those a later result or decision names by id or range
 * (the team claims it handled them) and those nobody answered.
 */
export function ledgerDigest(findings) {
  const open = [];
  const addressed = [];
  findings.forEach((f, i) => {
    if (f.type !== 'warning' && f.type !== 'failure') return;
    const n = Number(f.id.slice(2));
    const answer = findings.slice(i + 1).find((later) => (later.type === 'result' || later.type === 'decision') && referencedIds(later.message).has(n));
    (answer ? addressed : open).push(answer ? `${compact(f)} -> ${answer.id}` : compact(f));
  });
  return { open, addressed };
}

/** Paths from `git status --porcelain`, split into the risky ones to read first and the rest. */
export function changedFiles(porcelain) {
  const paths = porcelain.split('\n').filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop());
  const risk = paths.filter((p) => !NOTES.test(p) && RISK_PATTERNS.some((re) => re.test(p)));
  return { count: paths.length, readFirst: risk.slice(0, FILE_CAP), other: paths.filter((p) => !risk.includes(p)).slice(0, FILE_CAP) };
}

/** Markdown handoff so the next stage starts from one page instead of a long conversation. */
export function renderHandoff({ swarmId, spec, phase, report, ledger, openQuestions, ownerQuestions, steers, files, screens, brief }) {
  const list = (items, empty = 'None') => (items?.length ? items.map((x) => `- ${x}`).join('\n') : empty);
  const section = (name) => report?.[name]?.trim() || 'Not reported.';
  return `# Handoff: ${swarmId}

Phase: ${phase}. Workspace: ${spec.workspace}${spec.branch ? ` (branch ${spec.branch})` : ''}. Mode: ${spec.mode ?? 'build'}${spec.design ? ', design' : ''}.

${brief ? `Brief: ${brief} (read this instead of the sources).\n\n` : ''}## Objective
${spec.objective.trim()}

## Acceptance criteria
${list(spec.acceptanceCriteria)}

## Coordinator steers (decisions and owner facts given during the run)
${list(steers)}

## Lead's summary
${section('summary')}

## Lead's verification (claims, not proof)
${section('verification')}

## Open warnings and failures nobody answered
${list(ledger.open)}

## Open questions for the coordinator
${list(openQuestions)}
${ownerQuestions?.length ? `\n## Questions for the owner (show as one numbered list)\n${ownerQuestions.map((q) => `${q.n}. ${q.text}`).join('\n')}\n` : ''}

## Read these files first
${list(files?.readFirst, 'No risky files changed.')}
${files?.other?.length ? `\nOther changed files (${files.count} total):\n${list(files.other)}\n` : ''}${screens ? `\n## Screens\n${screens}\n` : ''}
## Lead's handoff
${section('handoff')}
`;
}
