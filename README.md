# DotSwarm

A Codex plugin that keeps the expensive model running your session for the work that needs its judgment. A team of inexpensive DeepSeek Flash agents, running inside the DeepSeek Harness (`dsh`), does the reading and the routine work: a `brief` swarm reads the sources and returns one condensed brief, a `build` swarm does work a spec fully determines, and a `verify` swarm runs every check and fixes mechanical defects so the coordinator never reads the output. The team coordinates through the harness's experimental Agent Teams subsystem, a shared task board and durable peer mailbox, plus a shared findings ledger that DotSwarm adds. The coordinator writes what users read and see and makes the decisions; it receives compressed state, steers on exceptions, and reads only the brief and the escalations.

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

## Updating

Codex keeps its own copy of the plugin, so new releases do not arrive on their own. Close every Codex window and session first; a running one holds the old copy open and the install reports `Access is denied`. Then, with the Codex CLI:

```sh
codex plugin marketplace upgrade dotswarm
codex plugin add dotswarm@dotswarm
```

Then start a new Codex session (open sessions keep the old version) and ask it to check that DotSwarm is set up, which installs a newer DeepSeek Harness if the release pins one. In the desktop app, remove the DotSwarm marketplace under **Plugins** and add it again. `codex plugin list` shows the installed version; compare it with the [latest release](https://github.com/Druidia-Bot/DotSwarm/releases).

## What the coordinator gets

| Tool | Purpose |
|---|---|
| `swarm_start` | `mode` `brief` (read and condense into `brief.md`), `build` (work a spec fully determines), `verify` (check, fix mechanical defects, escalate judgment), or `refactor`; objective, plan, acceptance criteria, context packet, absolute workspace, `max_agents`, `isolate`, `design`, `brief_words`, model and effort |
| `swarm_status` | compressed state; `wait_ms` blocks until the swarm needs you (plan, question, failure, warning or tool-error burst, idle/stopped/failed) and `wake` names the reason; `wake_on: "any"` wakes on every change; `since_finding` returns only new ledger entries; lists open questions, filtered tool errors, and a cost line |
| `swarm_steer` | one instruction to the Lead, delivered as its next turn and immediately as a ledger entry |
| `swarm_task_add` | hand the Lead a new board task instead of editing the workspace yourself |
| `swarm_inspect` | drill into `tasks`, `findings`, `roster`, `mail`, `errors`, `lead`, `member:<name>`, `events`, `prompts` |
| `swarm_result` | the Lead's report split into Summary, Changes, Verification, Unresolved, Handoff; `ledger.open` (warnings and failures nobody answered); `readFirst` (changed gates, scripts, config, schema, forms, auth); `git diff --stat`; `ownerQuestions` (every question for the owner at an approval gate, numbered and complete); and writes `handoff.md` so the next stage can start in a fresh session |
| `swarm_stop` | shut the runtime down; workspace changes stay |
| `swarm_resume` | continue a detached or finished swarm on the same worktree, seeded with the old board, the whole ledger, and the last report |
| `swarm_list` | swarms known to this server, including detached ones |
| `swarm_setup`, `swarm_doctor` | install the runtime into the data directory; report health |

The bundled `swarm` skill tells the coordinator how to use them: a brief swarm reads for it, it writes the creative and judgment work itself in few large turns, it hands off anything a spec and a command fully pin down, a verify swarm checks the result, and it starts each stage in a fresh session from `handoff.md`. It does not read what the swarm wrote; it reads the brief and the escalations. Set `design: true` for anything a person will look at: the team switches to the image-capable `deepseek-flash` model and must render each screen with Playwright at 390x844 and 1440x900, view it with `read_image`, critique it, and iterate at least twice, keeping screenshots outside the repository.

Isolation is on by default: in a git repository the team works in a worktree under the data directory on branch `swarm/<id>`, and `swarm_result` reports the branch for review and merge. Pass `isolate: false` to work directly in the checkout.

## What is ours and what is upstream

| Piece | Owner |
|---|---|
| Agent loop, tools, sandbox, sessions, task DAG, mailbox, `spawn_teammate`, `wait_agent` | DeepSeek Harness (`@deepseek-ai/dsh`, pinned, installed into the data directory at setup) plus `@deepseek-ai/dsh-experimental-agent-team-profile` |
| Stdio JSON-RPC client for the harness SDK protocol | `src/dsh-client.mjs` |
| Swarm lifecycle, event folding, compressed status, persistence, resume, worktrees | `src/swarm.mjs`, `src/swarm-state.mjs` |
| Lead prompt, worker protocol, review standard, quality bar, brief, verify, design, and refactor sections, report format | `src/prompt.mjs` |
| Result digest, risky-file list, and `handoff.md` | `src/digest.mjs` |
| Findings ledger and its MCP server | `src/findings.mjs`, `src/findings-server.mjs` |
| Minimal MCP stdio server | `src/mcp.mjs` |
| Profile generation, setup, doctor | `src/profile.mjs`, `src/setup.mjs` |

## Privacy and cost

The generated harness home disables telemetry, the upstream session-log contributor, and plugin-inventory contributions. Each swarm writes `<data dir>/swarms/<id>/` with the Lead prompt, an `events.jsonl` of every runtime notification, the findings ledger, screenshots, and its state. DeepSeek is charged for every team member. The coordinator's cost is set by how many turns it takes times how much it has read, so the skill keeps it to few, large turns: it reads the brief instead of the sources, writes its own part in batches, waits on `swarm_status` instead of polling, and reads only escalations, never the swarm's output. Set `DOTSWARM_PRICE_INPUT_PER_M` and `DOTSWARM_PRICE_OUTPUT_PER_M` (USD per million tokens) for a dollar estimate in the cost line.

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
