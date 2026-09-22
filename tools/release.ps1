#Requires -Version 5.1
<#
  release.ps1 - Standalone Migration S6 canonical Windows release flow.
  One script, no CI complexity added (per S6 scope: only add GitHub Actions
  if genuinely useful - this local flow already covers every required gate
  and this is a single-maintainer personal app, not a team project needing
  CI-triggered releases).

  Flow: safety gates -> clean build -> publish a DRAFT GitHub Release with
  artifacts + update metadata (latest.yml) -> stops. Promoting the draft to
  a real (published) release - the point at which electron-updater clients
  can see it - is a separate, deliberate manual step (`gh release edit
  <tag> --draft=false`) so a bad build is never auto-live.

  Usage:
    pwsh tools\release.ps1              # runs all gates + build + draft release
    pwsh tools\release.ps1 -SkipPublish # gates + build only, no GitHub Release
#>
[CmdletBinding()]
param(
  [switch]$SkipPublish
)

# Deliberately NOT 'Stop': native exes (git/gh/npm) writing to stderr on a
# perfectly normal path (e.g. gh's 404 for "does this release exist yet")
# get wrapped into a terminating ErrorRecord under 'Stop' in Windows
# PowerShell 5.1, which would abort this script on totally expected
# output. Every native call below checks $LASTEXITCODE explicitly instead.
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Fail($msg) {
  Write-Output "GATE FAILED: $msg"
  exit 1
}

Write-Output "=== S6 release safety gates ==="

# --- Gate: git working tree ---------------------------------------------
$gitStatus = git status --porcelain 2>&1
if ($LASTEXITCODE -ne 0) { Fail "not a git repository or git error" }
if ($gitStatus) {
  Write-Output "Uncommitted changes:`n$gitStatus"
  Fail "working tree is not clean - commit or stash before releasing"
}
Write-Output "  [ok] working tree clean"

# --- Gate: version / tag conflict ----------------------------------------
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
$existingTag = git tag -l $tag 2>&1
if ($existingTag) { Fail "tag $tag already exists locally" }
gh release view $tag --repo "tastantuna-dev/tuna-tastan-desktop" --json tagName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Fail "GitHub release $tag already exists" }
Write-Output "  [ok] version $version / tag $tag has no conflict"

# --- Gate: secret hygiene in source (not the build output yet) ----------
if (Test-Path 'config\local.json') {
  $tracked = git ls-files config/local.json
  if ($tracked) { Fail "config/local.json is tracked by git - must stay gitignored" }
}
if (Test-Path '.env') { Fail ".env exists in repo root - must not be committed/shipped" }
$trackedFiles = git ls-files
if ($trackedFiles -match '(?i)service_role|\.env$') { Fail "a tracked file name suggests a secret (service_role/.env)" }
Write-Output "  [ok] no service_role/.env/config-local-json tracked by git"

# --- Gate: no ChatGPT/OpenAI runtime reference in source (S4 regression) -
$sourceFiles = git ls-files 'src/*'
$chatgptHits = @()
foreach ($f in $sourceFiles) {
  if ((Get-Content $f -Raw -ErrorAction SilentlyContinue) -match '(?i)chatgpt\.site|auth\.openai\.com|chatgpt\.com') {
    $chatgptHits += $f
  }
}
if ($chatgptHits) { Fail "ChatGPT/OpenAI reference found in: $($chatgptHits -join ', ')" }
Write-Output "  [ok] no ChatGPT/OpenAI runtime reference in source"

Write-Output "=== Clean build ==="
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
npm run build
if ($LASTEXITCODE -ne 0) { Fail "electron-builder build failed" }
Write-Output "  [ok] build produced dist\ artifacts"

# --- Gate: artifact hygiene - open the zip, check nothing secret is inside
$zipPath = Get-ChildItem dist\*-win.zip | Select-Object -First 1 -ExpandProperty FullName
if (-not $zipPath) { Fail "no zip artifact found in dist\" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$badEntries = $zip.Entries | Where-Object { $_.FullName -match '(?i)\.env$|service_role|test.*profile|debug.*log' }
$zip.Dispose()
if ($badEntries) { Fail "suspicious entries in release zip: $($badEntries.FullName -join ', ')" }
Write-Output "  [ok] release zip contains no obviously sensitive files"

Write-Output "=== Gates passed, artifacts ready in dist\ ==="
Get-ChildItem dist -File | Select-Object Name, Length | Format-Table -AutoSize

if ($SkipPublish) {
  Write-Output "SkipPublish set - not creating a GitHub Release."
  exit 0
}

Write-Output "=== Creating DRAFT GitHub Release $tag ==="
$artifacts = Get-ChildItem dist -File | Where-Object { $_.Name -match '\.(exe|zip|blockmap|yml)$' } | Select-Object -ExpandProperty FullName
gh release create $tag $artifacts `
  --repo "tastantuna-dev/tuna-tastan-desktop" `
  --title "Tuna Tastan $version" `
  --notes "See PROBLEMS_SOLUTIONS.md / commit history for details." `
  --draft
if ($LASTEXITCODE -ne 0) { Fail "gh release create failed" }

git tag $tag
git push origin $tag

Write-Output "=== Draft release $tag created. Review it, then promote with: ==="
Write-Output "  gh release edit $tag --repo tastantuna-dev/tuna-tastan-desktop --draft=false"
