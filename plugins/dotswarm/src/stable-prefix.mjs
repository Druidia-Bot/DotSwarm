// Harness plugin mounted by the per-swarm patch, like the findings server. The Agent Teams
// policy section ends with "Your Team role is ...; your Team name is ...; Team id is ...", a
// few hundred tokens into every member's system prompt. The provider caches prompt prefixes,
// and the system prompt and the tool schemas after it are otherwise the same for every member,
// so that one sentence splits a shared prefix of several thousand tokens per member and per
// swarm. It moves the sentence, unchanged, into the runtime-context message, which the harness
// sends after the tool schemas.

export const name = 'dotswarm-stable-prefix';

const TEAM_POLICY_SECTION = 'team:policy';
const IDENTITY = /\n\nYour Team role is [^\n]*$/;

/**
 * @param {{sections: Array<{name: string, text: unknown}>, contexts: Array<{name: string, text: unknown}>}} assembly
 * @returns the same assembly with the identity sentence moved to the last runtime context.
 */
export function relocateTeamIdentity(assembly) {
  // Without a runtime-context message (suppressed, or nothing to report) the sentence stays put.
  if (!assembly.contexts?.length) return assembly;
  const index = assembly.sections.findIndex((section) => section.name === TEAM_POLICY_SECTION);
  const section = assembly.sections[index];
  const match = typeof section?.text === 'string' ? IDENTITY.exec(section.text) : null;
  if (!match) return assembly;
  return {
    ...assembly,
    sections: assembly.sections.with(index, { ...section, text: section.text.slice(0, match.index) }),
    contexts: [...assembly.contexts, { name: 'team:identity', text: match[0].trim() }],
  };
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => relocateTeamIdentity(await next()));
}
