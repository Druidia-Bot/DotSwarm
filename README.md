# DeepAstra Swarm (v2)

A Codex plugin that turns Astra into a foreman. Astra plans a task and hands it to a team of inexpensive DeepSeek Flash agents running inside the DeepSeek Harness (`dsh`). The team coordinates through the harness's experimental Agent Teams subsystem: a shared task board, a durable peer mailbox, and, added by this project, a shared findings ledger. Astra receives compressed state, steers on exceptions, and reviews the final report. Astra manages state, not conversation.

```
Codex Desktop (Astra)
  └─ plugin: deepastra-swarm  (skill + MCP server, 7 tools)
       └─ src/server.mjs      swarm_start / status / steer / inspect / result / stop / list
            └─ one dsh runtime per swarm   (profile "swarm" = dsh-base + sdk-app + agent-team)
                 ├─ Team Lead (Flash)       plans tasks, spawns teammates, reviews, reports
                 ├─ teammates (Flash)       explore / implement / test / review
                 ├─ task board + mailbox    upstream Agent Teams (durable, in the Lead session log)
                 └─ findings ledger         src/findings-server.mjs over MCP, JSONL per swarm
```

## What is ours and what is upstream

| Piece | Owner |
|---|---|
| Agent loop, tools, sandbox, sessions, task DAG, mailbox, `spawn_teammate`, `wait_agent` | DeepSeek Harness (`@deepseek-ai/dsh` 0.1.5-rc.2 pinned in `harness/`, plus `@deepseek-ai/dsh-experimental-agent-team-profile` installed into the generated profile) |
| JSON-RPC client for the SDK stdio protocol | `src/dsh-client.mjs` (the published SDK client pins a different `dsh` version, so we speak the documented protocol directly) |
| Swarm lifecycle, event folding, compressed status, worktree isolation | `src/swarm.mjs`, `src/swarm-state.mjs` |
| Lead prompt, worker protocol, final report format | `src/prompt.mjs` |
| Findings ledger MCP server | `src/findings.mjs`, `src/findings-server.mjs` |
| Profile generation and verification | `src/profile.mjs` |
| Codex plugin | `plugins/deepastra-swarm/` |

## Setup

Requirements: Node 22+, pnpm on PATH (dsh installs profile plugins with it), a DeepSeek API key.

```bash
npm install
npm run setup
```

`setup` installs the pinned harness into `harness/node_modules`, writes the `swarm` profile under `work/dsh-home/profiles/swarm`, installs the Agent Teams bundle into it, and verifies with `dsh --dump-config` that the SDK server and team rows compose. Then put the key where dsh looks for it:

```
work/dsh-home/.env
DEEPSEEK_API_KEY=...
```

Check everything:

```bash
npm run doctor
```

Register the plugin with Codex (copies `plugins/deepastra-swarm` into the personal plugin cache, records this directory as the application root, and enables the plugin in `~/.codex/config.toml` with a backup):

```powershell
./scripts/install-codex-plugin.ps1
```

Restart Codex. The `swarm` skill tells Astra when and how to use the tools.

## The tools Astra sees

| Tool | Purpose |
|---|---|
| `swarm_start` | objective, plan (5 to 15 work units), acceptance criteria, context packet, absolute workspace, `max_agents`, optional `isolate` (git worktree on `swarm/<id>`), model and effort |
| `swarm_status` | compressed state; `wait_ms` blocks until something changes instead of polling; `since_finding` returns only new ledger entries; lists `openQuestions` the Lead raised for Astra, filtered tool errors, and a `cost` line |
| `swarm_steer` | one instruction to the Lead, delivered as its next turn and immediately as a ledger entry of type `steer` |
| `swarm_task_add` | hand the Lead a new board task instead of Astra editing the workspace itself |
| `swarm_inspect` | drill into `tasks`, `findings`, `roster`, `mail`, `errors`, `lead`, `member:<name>`, `events`, `prompts` |
| `swarm_result` | the Lead's report split into Summary, Changes, Verification, Unresolved, Handoff, plus open warnings and `git diff --stat` |
| `swarm_stop` | shut the runtime down; workspace changes stay |
| `swarm_list` | swarms in this server process |

## Privacy and cost

The generated home disables telemetry, the upstream session-log contributor, and plugin-inventory contributions. Nothing under `work/` is committed. Set `DEEPASTRA_PRICE_INPUT_PER_M` and `DEEPASTRA_PRICE_OUTPUT_PER_M` (USD per million tokens) to get an `estimatedUsd` in the cost line. The skill's foreman rule matters for Astra's own spend: Astra must not edit the workspace or run its tests while a swarm runs; fixes become `swarm_task_add`, decisions become `swarm_steer`. Each swarm writes `work/swarms/<id>/` with the lead prompt, an `events.jsonl` of every runtime notification, the findings ledger, and the per-swarm patch. Token counts per session are summed into status. DeepSeek is charged for every team member; Astra pays only for planning, checkpoints, and review.

## Verification

```bash
npm test               # fake runtime: client, folding, findings server, plugin launcher, swarm lifecycle
npm run doctor         # real dsh: version, profile composition, key presence
npm run smoke:live     # spends tokens: one-teammate swarm creating a file in a temp dir
```

The live smoke is the first thing to run after setup. It has not been run in this checkout yet because no key was present.

## Known limits

- Agent Teams is upstream-experimental: one process, one shared checkout, advisory write scopes, no automatic ownership release. Use `isolate: true` for anything risky and let Astra reconcile the branch.
- No mid-turn cancel exists in the SDK protocol; `swarm_stop` ends the runtime.
- Swarms live in the MCP server process; when Codex restarts the server, running swarms are stopped. Their logs remain under `work/swarms/`.
- The `personal` marketplace layout was copied from the plugins already present in this Codex install; if Codex does not list the plugin after restart, add a `[marketplaces.personal]` entry pointing at the cache directory.
