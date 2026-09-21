#!/bin/sh
set -e
if ! command -v codex >/dev/null 2>&1; then
  echo 'Codex CLI is not on PATH. In the Codex desktop app use Plugins > Add > Add a marketplace with https://github.com/Druidia-Bot/DotSwarm instead.'
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo 'Git is required to add the marketplace. Install it and rerun.'
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 or newer is required to run DotSwarm. Install it from https://nodejs.org and rerun.'
  exit 1
fi

codex plugin marketplace add Druidia-Bot/DotSwarm
codex plugin add dotswarm@dotswarm

echo 'DotSwarm installed for Codex.'
echo 'Start a fresh Codex session and ask it to "check that DotSwarm is set up". The swarm_setup tool installs the DeepSeek Harness runtime into your local DotSwarm data directory (needs npm and pnpm on PATH), then put DEEPSEEK_API_KEY=... in the key file it names.'
