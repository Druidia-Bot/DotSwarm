# DotSwarm

A Codex plugin that turns the model running your session into a foreman. It plans a task and hands it to a team of inexpensive DeepSeek Flash agents running inside the DeepSeek Harness (`dsh`). The team coordinates through the harness's experimental Agent Teams subsystem, a shared task board and durable peer mailbox, plus a shared findings ledger that DotSwarm adds. The coordinator receives compressed state, steers on exceptions, audits the result, sends a refactor team, and does a final sweep. It manages state, not conversation.

```
Codex session (any model)
  └─ plugin: dotswarm  (skill + zero-dependency MCP server)
       └─ one dsh runtime per swarm   (profile "swarm" = dsh-base + sdk-app + agent-team)
            ├─ Team Lead (Flash)       plans tasks, spawns teammates, reviews, reports
            ├─ teammates (Flash)       explore / implement / test / design / review
            ├─ task board + mailbox    upstream Agent Teams (durable, in the Lead session log)
            └─ findings ledger         DotSwarm, over MCP, one JSONL per swarm
```

## Install

Requirements on the machine running Codex: Node.js 22+, git, npm, and pnpm (used once to install the Agent Teams bundle). A DeepSeek API key.

In the Codex desktop app: **Plugins > Add > Add a marketplace**, paste `https://github.com/Druidia-Bot/DotSwarm`, then install **DotSwarm**.

With the Codex CLI on Windows:

```powershell
irm https://raw.githubusercontent.com/Druidia-Bot/DotSwarm/main/install-codex.ps1 | iex
```

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotSwarm/main/install-codex.sh | sh
```

Then, in a fresh Codex session, ask it to check that DotSwarm is set up. The `swarm_setup` tool installs the pinned DeepSeek Harness and Agent Teams bundle into your local DotSwarm data directory (`%LOCALAPPDATA%\DotSwarm` on Windows, `~/.dotswarm` elsewhere; override with `DOTSWARM_HOME`). Put your key in the file it names:

```
<data dir>/dsh-home/.env
DEEPSEEK_API_KEY=...
```

`swarm_doctor` confirms everything. Claude Code users can add the same repository as a marketplace; the plugin manifest for it is included.

## What the coordinator gets

| Tool | Purpose |
|---|---|
| `swarm_start` | objective, plan (5 to 15 work units), acceptance criteria, context packet, absolute workspace, `max_agents`, `isolate`, `design`, `mode`, model and effort |
| `swarm_status` | compressed state; `wait_ms` blocks until something changes; `since_finding` returns only new ledger entries; lists open questions, filtered tool errors, and a cost line |
| `swarm_steer` | one instruction to the Lead, delivered as its next turn and immediately as a ledger entry |
| `swarm_task_add` | hand the Lead a new board task instead of editing the workspace yourself |
| `swarm_inspect` | drill into `tasks`, `findings`, `roster`, `mail`, `errors`, `lead`, `member:<name>`, `events`, `prompts` |
| `swarm_result` | the Lead's report split into Summary, Changes, Verification, Unresolved, Handoff, plus open warnings and `git diff --stat` |
| `swarm_stop` | shut the runtime down; workspace changes stay |
| `swarm_resume` | continue a detached or finished swarm on the same worktree, seeded with the old board, the whole ledger, and the last report |
| `swarm_list` | swarms known to this server, including detached ones |
| `swarm_setup`, `swarm_doctor` | install the runtime into the data directory; report health |

The bundled `swarm` skill tells the coordinator how to use them: plan first, do not touch the workspace while the team runs, steer only on exceptions, verify the report itself, audit every changed file, resume in `refactor` mode with the audit list, then a final sweep. Set `design: true` for anything a person will look at: the team switches to the image-capable `deepseek-flash` model and must render each screen with Playwright at 390x844 and 1440x900, view it with `read_image`, critique it, and iterate at least twice, keeping screenshots outside the repository.

Isolation is on by default: in a git repository the team works in a worktree under the data directory on branch `swarm/<id>`, and `swarm_result` reports the branch for review and merge. Pass `isolate: false` to work directly in the checkout.

## What is ours and what is upstream

| Piece | Owner |
|---|---|
| Agent loop, tools, sandbox, sessions, task DAG, mailbox, `spawn_teammate`, `wait_agent` | DeepSeek Harness (`@deepseek-ai/dsh`, pinned, installed into the data directory at setup) plus `@deepseek-ai/dsh-experimental-agent-team-profile` |
| Stdio JSON-RPC client for the harness SDK protocol | `src/dsh-client.mjs` |
| Swarm lifecycle, event folding, compressed status, persistence, resume, worktrees | `src/swarm.mjs`, `src/swarm-state.mjs` |
| Lead prompt, worker protocol, design and refactor sections, report format | `src/prompt.mjs` |
| Findings ledger and its MCP server | `src/findings.mjs`, `src/findings-server.mjs` |
| Minimal MCP stdio server | `src/mcp.mjs` |
| Profile generation, setup, doctor | `src/profile.mjs`, `src/setup.mjs` |

## Privacy and cost

The generated harness home disables telemetry, the upstream session-log contributor, and plugin-inventory contributions. Each swarm writes `<data dir>/swarms/<id>/` with the Lead prompt, an `events.jsonl` of every runtime notification, the findings ledger, screenshots, and its state. DeepSeek is charged for every team member; the coordinator pays only for planning, checkpoints, audit, and review, and only if it follows the foreman rule. Set `DOTSWARM_PRICE_INPUT_PER_M` and `DOTSWARM_PRICE_OUTPUT_PER_M` (USD per million tokens) for a dollar estimate in the cost line.

## Development

```bash
cd plugins/dotswarm
npm install            # test dependencies only
npm test               # fake runtime: client, folding, findings server, plugin launcher, swarm lifecycle, resume
npm run setup          # real dsh into the data directory
npm run doctor
npm run smoke:live     # spends tokens: one-teammate swarm creating a file in a temp dir
npm run monitor        # replay any swarm's log from outside the server
```

## Known limits

- Agent Teams is upstream-experimental: one process, one shared checkout, advisory write scopes, no automatic ownership release. Isolation and the reviewer role exist because of this.
- No mid-turn cancel exists in the SDK protocol; `swarm_stop` ends the runtime.
- Resume is seeding, not reattachment: the harness's SDK server only creates sessions, so a Codex restart ends the old teammates' turns. Their work on disk and the ledger survive and feed the successor team.
- The workspace-write sandbox on Windows blocks spawning native toolchain binaries, so the default permission mode is full access; the objective's boundaries are what keep the team out of other repositories.
