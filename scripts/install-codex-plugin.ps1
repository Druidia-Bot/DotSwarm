param(
  [string] $CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
  [string] $Marketplace = 'personal'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $root 'plugins/deepastra-swarm/.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$target = Join-Path $CodexHome "plugins\cache\$Marketplace\deepastra-swarm\$version"

if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $root 'plugins/deepastra-swarm/*') -Destination $target -Recurse -Force
@{ root = $root } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'runtime.json') -Encoding UTF8

$config = Join-Path $CodexHome 'config.toml'
$key = "deepastra-swarm@$Marketplace"
$text = if (Test-Path -LiteralPath $config) { Get-Content -LiteralPath $config -Raw } else { '' }
if ($text -notmatch [regex]::Escape("[plugins.`"$key`"]")) {
  Copy-Item -LiteralPath $config -Destination "$config.deepastra-swarm-backup-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $config -Value "`n[plugins.`"$key`"]`nenabled = true`n" -Encoding UTF8
  Write-Host "Enabled $key in $config (backup written beside it)."
} else {
  Write-Host "$key already present in $config."
}
Write-Host "Installed plugin files to $target"
Write-Host "Application root recorded as $root. Restart Codex so the plugin and its MCP server load."
