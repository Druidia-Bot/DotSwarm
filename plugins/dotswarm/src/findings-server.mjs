#!/usr/bin/env node
// MCP stdio server mounted inside the DeepSeek Harness runtime so every team
// member can record and read shared findings. The ledger file comes from
// SWARM_FINDINGS_FILE. Tools appear to the models as mcp__findings__record_finding
// and mcp__findings__list_findings.
import { VERSION } from './config.mjs';
import { Findings, FINDING_TYPES } from './findings.mjs';
import { serveStdio } from './mcp.mjs';

const file = process.env.SWARM_FINDINGS_FILE;
if (!file) {
  console.error('SWARM_FINDINGS_FILE is required');
  process.exit(2);
}
const findings = new Findings(file);

const TOOLS = [
  {
    name: 'record_finding',
    description: 'Append one finding to the shared team ledger so every teammate and the Lead can see it. Use for discoveries that affect other tasks, warnings, failures, decisions, and open questions. Not for routine status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['author', 'type', 'scope', 'message'],
      properties: {
        author: { type: 'string', description: 'Your team member name (lead or the teammate name you were given).' },
        type: { type: 'string', enum: FINDING_TYPES },
        scope: { type: 'string', description: 'Area the finding concerns: a path prefix, module, or topic such as auth, tests, db/migrations.' },
        message: { type: 'string', description: 'Self-contained finding, concrete and short. Include file paths and evidence.' },
      },
    },
  },
  {
    name: 'list_findings',
    description: 'Read the shared team findings ledger, newest last. Pass since with the last finding id you have seen to receive only newer entries; filter by scope prefix or type.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: { type: 'string', description: 'Last finding id already seen, such as F-012. Only newer entries are returned.' },
        scope: { type: 'string' },
        type: { type: 'string', enum: FINDING_TYPES },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
  },
];

serveStdio({
  name: 'findings',
  version: VERSION,
  tools: TOOLS,
  onClose: () => process.exit(0),
  call(name, args) {
    if (name === 'record_finding') {
      const row = findings.append(args);
      return JSON.stringify({ recorded: row.id });
    }
    const rows = findings.list(args);
    const empty = args.since ? `No findings newer than ${args.since}.` : 'No findings recorded yet.';
    return rows.length ? Findings.render(rows) : empty;
  },
});
