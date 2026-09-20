// Prompt composition: what the Team Lead receives from Astra, and the standing
// protocol every teammate must be given. Astra manages state, not conversation,
// so the Lead is told exactly how to report so swarm_result stays compact.

export const REPORT_HEADINGS = ['Summary', 'Changes', 'Verification', 'Unresolved', 'Handoff'];

export const WORKER_PROTOCOL = `TEAM PROTOCOL (give this to every teammate verbatim)
Before starting:
- Call team_task_list and team_task_get for your assigned task. Claim it with team_task_update action=claim using the current revision.
- Call mcp__findings__list_findings for your scope before touching code.
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
export function buildLeadPrompt(spec) {
  const roles = spec.roles?.length ? spec.roles : suggestedRoles(spec.maxAgents);
  const criteria = spec.acceptanceCriteria?.length
    ? bullet(spec.acceptanceCriteria)
    : '- The objective is met and every change is verified by running the relevant tests or commands.';
  return `You are the Team Lead of swarm ${spec.swarmId}. Astra, the supervising architect, planned this work and will review the outcome. Astra is not in this conversation; messages framed as [Astra steer] are its instructions and take priority.

Use Agent Teams for this work. Create up to ${spec.maxAgents} teammates with spawn_teammate (fresh context) and coordinate them through the shared task board and mailbox. Do the planning, arbitration, and final review yourself; delegate exploration, implementation, testing, and review to teammates so they run in parallel.

WORKSPACE
${spec.workspace}${spec.isolated ? ' (an isolated git worktree on its own branch; commit nothing, Astra reconciles the diff)' : ''}
All members share this checkout. Split write work into disjoint write scopes, record them on tasks, and order dependent work with task dependencies. Write scopes are advisory, not locks.

OBJECTIVE
${spec.objective.trim()}

${spec.plan ? `PLAN FROM ASTRA\n${spec.plan.trim()}\n\n` : ''}ACCEPTANCE CRITERIA
${criteria}

${spec.context ? `CONTEXT PACKET\n${spec.context.trim()}\n\n` : ''}SUGGESTED TEAMMATE ROLES
${bullet(roles)}
Adjust the roster to the work; fewer teammates is better when the work is small.

HOW TO RUN THE SWARM
1. Inspect the workspace briefly, then create the shared tasks with team_task_create: one per meaningful work unit, each with a complete description, acceptance criteria, write scopes, and blocked_by dependencies. Record the task plan as a finding of type decision with author lead.
2. Spawn teammates. Each spawn prompt must contain: the objective in one paragraph, the task ids they own, the acceptance criteria for those tasks, the exact verification commands, and the TEAM PROTOCOL below verbatim.
3. Monitor with list_agents, team_task_list, mcp__findings__list_findings, and wait_agent. After each wakeup ask: what do we know, what conflicts, what is unverified, is another teammate actually useful? Redirect with send_message. Reassign or reopen tasks that stall.
   Astra's instructions arrive two ways: as a [Astra steer] message at your next turn, and immediately as a finding of type steer with author astra. Call mcp__findings__list_findings with type steer after every wait_agent and before completing any task, and apply new steers at once. Each steer id counts once; do not re-apply one you already handled.
   If a build tool, test runner, or package install fails with EPERM, spawn errors, or a sandbox escalation message, do not reverse-engineer the tool. Record a finding of type failure with the exact error and stop that workstream; Astra restarts the swarm with a different permission mode.
4. When all tasks are complete, review the complete diff yourself, run the acceptance verification, and fix or delegate anything that fails.
5. Finish with the FINAL REPORT format below and nothing after it. Do not stop while a required teammate is still running.

${WORKER_PROTOCOL}

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
What Astra should review or decide next.`;
}

export function buildSteerPrompt(instruction, findingId) {
  return `[Astra steer]${findingId ? ` (${findingId})` : ''}\n${instruction.trim()}\n\nApply this now. If it changes the task plan, update the task board and tell affected teammates. Continue until the FINAL REPORT is complete.`;
}

export function suggestedRoles(maxAgents) {
  const all = [
    'explorer: map the relevant code, record findings, no edits',
    'implementer: make the code changes for assigned tasks',
    'tester: write and run tests against the acceptance criteria',
    'reviewer: adversarially review the diff and record failures',
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
