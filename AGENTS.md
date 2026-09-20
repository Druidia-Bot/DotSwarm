# Working in this repository

- v2 is the swarm architecture: Astra (Codex) supervises, a DeepSeek Harness Agent Team works. v1 (the consultation companion) lives on the `v1` branch and is not referenced here.
- Nothing of ours goes into `harness/node_modules` or `work/`. Upstream is consumed as a pinned npm package plus a generated profile. Upgrade by changing the exact version in `harness/package.json`, then `npm run setup -- --reinstall`.
- The SDK protocol is small and documented upstream (`initialize`, `session/prompt`, `shutdown`, four notifications). Keep `src/dsh-client.mjs` to that contract; do not import upstream runtime packages into this process.
- Status must stay compressed. Add fields to `Swarm.status()` only when Astra needs them to decide something; put everything else behind `swarm_inspect`.
- Tests run against `test/fixtures/fake-dsh.mjs`. Anything that changes the wire contract needs a fixture change and a live smoke (`npm run smoke:live`) before it is called done.
- Resume is seeded, not reattached: the SDK server calls `agents.create` only, so `swarm_resume` starts a new Lead from the persisted board, ledger, and last report. Do not promise runtime reattachment unless upstream adds a resume method to the SDK protocol.
- Never write keys into the tree. dsh reads `DEEPSEEK_API_KEY` from the environment or `work/dsh-home/.env`.
