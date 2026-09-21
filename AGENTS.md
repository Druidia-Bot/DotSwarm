# Working in this repository

- This repository is a Codex and Claude Code plugin marketplace. The only plugin is `plugins/dotswarm`, which must stay self-contained: Codex copies that directory into its cache and runs `server.mjs` from there with nothing installed but Node. Runtime code therefore has no npm dependencies; `@modelcontextprotocol/sdk` is a devDependency used only by the tests.
- Everything generated lives in the per-user data directory (`DOTSWARM_HOME`, else `%LOCALAPPDATA%\DotSwarm` or `~/.dotswarm`): the pinned harness install, the generated dsh profile, the key file, swarm logs, and worktrees. Nothing of ours goes into the harness's `node_modules`, and nothing generated goes into this tree.
- Upstream is consumed as a pinned npm package plus a generated profile. Upgrade by changing `DSH_VERSION` and `TEAM_PROFILE_VERSION` in `src/config.mjs`, then `swarm_setup` with `reinstall` or `npm run setup -- --reinstall`, then the live smoke.
- The SDK protocol is small and documented upstream (`initialize`, `session/prompt`, `shutdown`, four notifications). Keep `src/dsh-client.mjs` to that contract; do not import upstream runtime packages into this process.
- Resume is seeded, not reattached: the SDK server calls `agents.create` only, so `swarm_resume` starts a new Lead from the persisted board, ledger, and last report. Do not promise runtime reattachment unless upstream adds a resume method.
- Status must stay compressed. Add fields to `Swarm.status()` only when the coordinator needs them to decide something; put everything else behind `swarm_inspect`.
- The coordinator is whichever model runs the session. Model-facing text says "the coordinator", never a model or product name.
- Tests run against `test/fixtures/fake-dsh.mjs`. Anything that changes the wire contract needs a fixture change and a live smoke (`npm run smoke:live`) before it is called done.
- Never write keys into the tree. dsh reads `DEEPSEEK_API_KEY` from the environment or `<data dir>/dsh-home/.env`.
- Bump the version in `plugins/dotswarm/package.json`, both `plugin.json` files, and `.claude-plugin/marketplace.json` together.
