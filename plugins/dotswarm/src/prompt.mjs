// Prompt composition: what the Team Lead receives from the coordinator, and the standing
// protocol every teammate must be given. The coordinator manages state, not conversation,
// so the Lead is told exactly how to report so swarm_result stays compact.

export const REPORT_HEADINGS = ['Summary', 'Changes', 'Verification', 'Unresolved', 'Handoff'];

export const WORKER_PROTOCOL = `TEAM PROTOCOL (give this to every teammate verbatim)
Before starting:
- Call team_task_list and team_task_get for your assigned task. Claim it with team_task_update action=claim using the current revision.
- Call mcp__findings__list_findings for your scope before touching code. Later calls pass since with the last id you saw.
While working:
- Keep your task's write scopes. If you must touch files outside them, message the lead first.
- Record discoveries that affect other tasks, warnings, and failures with mcp__findings__record_finding (author = your teammate name). Do not record routine progress.
- Message a teammate directly with send_message only when they need information from you. Do not send status chatter.
When blocked:
- Message the teammate who can unblock you; if none can, message the lead with the exact blocker and evidence.
When finished:
- Run the verification named in your task. Complete the task with team_task_update action=complete only after verification passed or you have recorded the failure as a finding.
- Send the lead one message: what changed, files changed, tests run with results, unresolved concerns.`;

function bullet(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * @param {object} spec
 * @param {string} spec.swarmId
 * @param {string} spec.objective
 * @param {string} [spec.plan]
 * @param {string[]} [spec.acceptanceCriteria]
 * @param {string} [spec.context]
 * @param {number} spec.maxAgents
 * @param {string[]} [spec.roles]
 * @param {string} spec.workspace
 * @param {boolean} [spec.isolated]
 */
/**
 * Section handed to the Lead of a resumed swarm: what the previous team had
 * done, since the runtime cannot reattach to the old session.
 * @param {object} resume
 * @param {string} resume.fromSwarmId
 * @param {Array<{id: string, subject: string, status: string, owner?: string|null}>} resume.tasks
 * @param {string} [resume.lastLeadMessage]
 * @param {number} resume.findingsCount
 * @param {string} [resume.instruction]
 */
export function buildResumeSection(resume) {
  const board = resume.tasks.length
    ? resume.tasks.map((t) => `- ${t.id} [${t.status}${t.owner ? `, was ${t.owner}` : ''}] ${t.subject}`).join('\n')
    : '- (the previous team had not created tasks yet)';
  return `RESUMING PREVIOUS SWARM ${resume.fromSwarmId}
A previous team worked on this objective in this same workspace and was interrupted. Its teammates and task board are gone, but its work on disk and its findings ledger remain. The ledger already holds ${resume.findingsCount} entries from that team, including its plan, decisions, warnings, and results. Read the whole ledger with mcp__findings__list_findings before planning; do not redo verified work, and do not trust unverified claims.

PREVIOUS TASK BOARD (final state)
${board}

${resume.lastLeadMessage ? `PREVIOUS LEAD'S LAST MESSAGE\n${resume.lastLeadMessage}\n\n` : ''}${resume.instruction ? `THE COORDINATOR'S INSTRUCTION FOR THE RESUME\n${resume.instruction}\n\n` : ''}Re-create only the remaining work as tasks, verify what the previous team claimed as complete, then continue to the FINAL REPORT.`;
}

/** How the reviewer judges work: the standard the coordinator would otherwise have to apply in its own audit. */
export const REVIEW_STANDARD = `REVIEW STANDARD (give this to the reviewer verbatim)
- Prove every failure. Reproduce it with a command, a test, or a small fixture and record the evidence in the finding. A claim you cannot reproduce is a question, not a failure.
- Read the result the way its real user will. For anything people read, read the rendered text as that audience and flag wording that sounds like internal notes, audits, compliance, or tooling. For code, read the diff as its next maintainer.
- A fact about an outside entity (a company record, a licence, an address, a person) is verified only when the source matches on name and at least one other identifier. Otherwise it is a candidate and must not be presented as fact.
- Check the checks. A validator, gate, or release script passes review only if it fails when it should: run it against a deliberately bad input and confirm a nonzero exit.
- Review the whole set, not only each piece: repeated sentences across outputs, claims used where they are not allowed, one piece contradicting another.
- Record each problem as its own finding of type failure or warning with the file and the exact text or line. Do not approve your own team's work on the user's behalf.`;

/** Defects the coordinator's audit kept finding after green builds; every swarm checks these. */
export const QUALITY_BAR = `QUALITY BAR
- Any script that gates a release, build, or deploy exits nonzero when it blocks. A gate that prints a warning and exits 0 is a defect.
- Validation the build depends on lives in the project and runs from npm scripts or the test suite; never depend on paths outside the workspace.
- Structured data (JSON-LD, sitemaps, feeds) is generated only from verified facts. Serialize JSON-LD with '<' escaped before injecting it into HTML.
- Form controls that are required carry the required attribute and aria-required; errors are announced and tied to their field.
- Rerun the acceptance commands after the final edit, not before it. The FINAL REPORT reflects the last run.`;

/** Screenshot-driven iteration protocol for swarms that touch anything a person sees. */
export function buildDesignSection({ screensDir }) {
  return `UX AND DESIGN ITERATION
This swarm's model can see images. Anything a person will look at is not done until it has been rendered, viewed, critiqued, and improved in a real browser.
- Assign one teammate the designer role for all user-facing screens and components. The reviewer views the final screenshots independently.
- Run the application locally (dev server or built preview). Render each screen with Playwright at 390x844 and 1440x900. If the project has no Playwright, add it as a devDependency and install chromium; never commit browser binaries or screenshots into the repository.
- Before every capture wait for document.fonts.ready, scroll the full page so lazy media loads, wait until every visible img is complete with naturalWidth greater than 0 and decoded, then wait two animation frames. A blank or unstyled region in a screenshot is a capture defect: re-capture before judging.
- Save screenshots outside the repository under ${screensDir} as <screen>-<viewport>-v<round>.png, then view each one with read_image. Do not judge a screen from its DOM or its code.
- Critique every screenshot against the objective's visual direction and these checks: visual hierarchy, spacing rhythm, typography scale and readability, colour contrast (text 4.5:1, input borders and focus rings 3:1), alignment, overflow or clipping, empty, loading, and error states, focus visibility, touch targets of at least 44 by 44 px, tables and wide content at 390 px without horizontal scroll, and how it looks with content of realistic length. Measure contrast and target sizes with a script across every route rather than eyeballing them. Record each critique as a finding of type discovery with scope ui/<screen>.
- Iterate: fix, re-render, view again. At least two rounds per screen; stop when a round produces no material improvement. Keep the best version, not the last one.
- In the FINAL REPORT Verification section, list every screen with its final screenshot path, the number of rounds, and what changed between the first and final round.`;
}

/** Rules for a swarm whose job is to act on the coordinator's audit, not to build. */
export function buildRefactorSection() {
  return `REFACTOR MODE
This swarm exists to resolve the audit items the coordinator listed in the instruction or context packet. It does not add features.
- Run the complete test suite and type check first and record the baseline as a finding of type result. Every task must leave them green.
- Preserve behaviour unless an audit item explicitly asks for a change; a task that must change behaviour records a finding of type decision before editing.
- One audit item, or one coherent group of items, per task, with disjoint write scopes. Prefer deleting and simplifying over adding.
- Every resolved item gets a finding of type result naming the audit id and the files touched. An item that cannot be resolved safely gets a finding of type question naming the id and the reason.
- The FINAL REPORT Changes section maps each audit id to what was done, and the Unresolved section lists every id not resolved.`;
}

export function buildLeadPrompt(spec) {
  const roles = spec.roles?.length ? spec.roles : suggestedRoles(spec.maxAgents, { design: Boolean(spec.design) });
  const criteria = spec.acceptanceCriteria?.length
    ? bullet(spec.acceptanceCriteria)
    : '- The objective is met and every change is verified by running the relevant tests or commands.';
  return `You are the Team Lead of swarm ${spec.swarmId}. The coordinator, the supervising architect, planned this work and will review the outcome. The coordinator is not in this conversation; messages framed as [Coordinator steer] are its instructions and take priority.

Use Agent Teams for this work. Create up to ${spec.maxAgents} teammates with spawn_teammate (fresh context) and coordinate them through the shared task board and mailbox. Do the planning, arbitration, and final review yourself; delegate exploration, implementation, testing, and review to teammates so they run in parallel.

WORKSPACE
${spec.workspace}${spec.isolated ? ' (an isolated git worktree on its own branch; commit nothing, the coordinator reconciles the diff)' : ''}
All members share this checkout. Split write work into disjoint write scopes, record them on tasks, and order dependent work with task dependencies. Write scopes are advisory, not locks.

OBJECTIVE
${spec.objective.trim()}

${spec.plan ? `PLAN FROM THE COORDINATOR\n${spec.plan.trim()}\n\n` : ''}ACCEPTANCE CRITERIA
${criteria}

${spec.context ? `CONTEXT PACKET\n${spec.context.trim()}\n\n` : ''}${spec.resume ? `${buildResumeSection(spec.resume)}\n\n` : ''}${spec.mode === 'refactor' ? `${buildRefactorSection()}\n\n` : ''}${spec.design ? `${buildDesignSection({ screensDir: spec.screensDir ?? 'the swarm directory' })}\n\n` : ''}${QUALITY_BAR}

SUGGESTED TEAMMATE ROLES
${bullet(roles)}
Adjust the roster to the work; fewer teammates is better when the work is small.

HOW TO RUN THE SWARM
1. Inspect the workspace briefly, then create the shared tasks with team_task_create: one per meaningful work unit, each with a complete description, acceptance criteria, write scopes, and blocked_by dependencies. Record the task plan as a finding of type decision with author lead and scope plan; record any later change to the plan the same way. The coordinator wakes on that scope to check the plan before the team builds on it.
2. Spawn teammates. Each spawn prompt must contain: the objective in one paragraph, the task ids they own, the acceptance criteria for those tasks, the exact verification commands, and the TEAM PROTOCOL below verbatim. The reviewer's prompt also contains the REVIEW STANDARD below verbatim.
3. Monitor with list_agents, team_task_list, mcp__findings__list_findings, and wait_agent. After each wakeup ask: what do we know, what conflicts, what is unverified, is another teammate actually useful? Redirect with send_message. Reassign or reopen tasks that stall.
   The coordinator's instructions arrive two ways: as a [Coordinator steer] message at your next turn, and immediately as a finding of type steer with author coordinator. After every wait_agent and before completing any task, call mcp__findings__list_findings with since set to the last finding id you have seen, so you read only new entries; apply new steers at once. A steer beginning "TASK REQUEST" becomes a task on the board with team_task_create. Each steer id counts once; do not re-apply one you already handled.
   Anything you need from the coordinator (a decision, a file you must not edit, missing configuration, an approval) is a finding of type question with scope coordinator. The coordinator sees those directly; do not bury them in messages. When the coordinator answers, record the outcome as a finding of type result that names the question id.
   If a build tool, test runner, or package install fails with EPERM, spawn errors, or a sandbox escalation message, do not reverse-engineer the tool. Record a finding of type failure with the exact error and stop that workstream; the coordinator restarts the swarm with a different permission mode.
4. When all tasks are complete, review the complete diff yourself, run the acceptance verification, and fix or delegate anything that fails.
   A reviewer's failure or warning is fixed in the work by default. Relax a rule, a limit, or an allow-list only when the rule itself is wrong, and record a finding of type decision that names the finding id and the reason before changing it. Every warning or failure gets a finding of type result or decision that names its id, so the coordinator can see it was answered.
   After the last edit of any kind, rerun every acceptance command. Do not write the FINAL REPORT from an earlier run.
5. Finish with the FINAL REPORT format below and nothing after it. Do not stop while a required teammate is still running.

${WORKER_PROTOCOL}

${REVIEW_STANDARD}

FINAL REPORT (use exactly these headings)
## Summary
Two to five sentences: what was done and whether the acceptance criteria are met.
## Changes
Files changed, one line each, with the purpose.
## Verification
Each command run and its actual result. Say plainly when something was not verified.
## Unresolved
Open problems, risks, and findings of type warning or failure that remain. Write "None" when empty.
## Handoff
What the coordinator should review or decide next.`;
}

export function buildSteerPrompt(instruction, findingId) {
  return `[Coordinator steer]${findingId ? ` (${findingId})` : ''}\n${instruction.trim()}\n\nApply this now. If it changes the task plan, update the task board and tell affected teammates. Continue until the FINAL REPORT is complete.`;
}

export function suggestedRoles(maxAgents, { design = false } = {}) {
  // A reviewer comes second: an independent check is worth more than a second pair of hands.
  const all = [
    'implementer: make the code changes for assigned tasks',
    'reviewer: adversarially review the work against the REVIEW STANDARD and record failures with evidence',
    ...(design ? ['designer: render, screenshot, critique, and iterate every user-facing screen'] : []),
    'explorer: map the relevant code, record findings, no edits',
    'tester: write and run tests against the acceptance criteria',
    'implementer-2: a second implementer for a disjoint write scope',
    'researcher: read docs or references and record findings',
    'implementer-3: a third implementer for a disjoint write scope',
  ];
  return all.slice(0, Math.max(1, Math.min(maxAgents, all.length)));
}

/** Split a FINAL REPORT into its sections when the Lead followed the format. */
export function parseReport(text) {
  const sections = {};
  const pattern = /^##\s+(Summary|Changes|Verification|Unresolved|Handoff)\s*$/gim;
  const matches = [...(text ?? '').matchAll(pattern)];
  if (!matches.length) return null;
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections[match[1].toLowerCase()] = text.slice(start, end).trim();
  });
  return sections;
}
