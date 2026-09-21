if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  Write-Host 'Codex CLI is not on PATH. In the Codex desktop app use Plugins > Add > Add a marketplace with https://github.com/Druidia-Bot/DotSwarm instead.' -ForegroundColor Yellow
  return
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Git is required to add the marketplace. Install it from https://git-scm.com/downloads and rerun.' -ForegroundColor Yellow
  return
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js 22 or newer is required to run DotSwarm. Install it from https://nodejs.org and rerun.' -ForegroundColor Yellow
  return
}

codex plugin marketplace add Druidia-Bot/DotSwarm
if ($LASTEXITCODE -ne 0) { Write-Host 'Adding the DotSwarm marketplace failed. Review the output above and rerun.' -ForegroundColor Yellow; return }

codex plugin add dotswarm@dotswarm
if ($LASTEXITCODE -ne 0) { Write-Host 'Installing DotSwarm failed. Review the output above and rerun.' -ForegroundColor Yellow; return }

Write-Host 'DotSwarm installed for Codex.' -ForegroundColor Green
Write-Host 'Start a fresh Codex session and ask it to "check that DotSwarm is set up". The swarm_setup tool installs the DeepSeek Harness runtime into your local DotSwarm data directory (needs npm and pnpm on PATH), then put DEEPSEEK_API_KEY=... in the key file it names.'
