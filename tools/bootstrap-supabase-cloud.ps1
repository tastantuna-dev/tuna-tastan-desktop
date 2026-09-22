#Requires -Version 5.1
<#
  bootstrap-supabase-cloud.ps1 - readiness/validation for the S2 cloud-only
  Supabase backend. Does NOT create an account, project, or perform any
  login - that step needs a real human completing OAuth/email signup once
  (see STANDALONE_MIGRATION_S2 / PS-140). This script only checks that the
  pieces the app needs are correctly in place, and runs a few safe,
  unauthenticated smoke checks against a real project once one exists.

  Never prints the anon key value (only whether it's present and roughly
  well-formed). Never touches, requests, or accepts a service_role key.

  Usage:
    pwsh tools\bootstrap-supabase-cloud.ps1
    pwsh tools\bootstrap-supabase-cloud.ps1 -Json
#>
[CmdletBinding()]
param(
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param([string]$Name, [string]$Status, [string]$Detail)
  $checks.Add([pscustomobject]@{ Check = $Name; Status = $Status; Detail = $Detail })
}

# --- 1. Config presence ----------------------------------------------------
$configPath = Join-Path $repoRoot 'config\local.json'
$examplePath = Join-Path $repoRoot 'config\local.example.json'
$url = $env:TUNA_SUPABASE_URL
$anonKey = $env:TUNA_SUPABASE_ANON_KEY
$configSource = 'environment variables'

if (-not $url -or -not $anonKey) {
  if (Test-Path -LiteralPath $configPath) {
    try {
      $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      if (-not $url) { $url = $cfg.supabaseUrl }
      if (-not $anonKey) { $anonKey = $cfg.supabaseAnonKey }
      $configSource = 'config\local.json'
    } catch {
      Add-Check 'config_file_parses' 'FAIL' "config\local.json exists but is not valid JSON: $($_.Exception.Message)"
    }
  }
}

if ($url -and $anonKey) {
  Add-Check 'config_present' 'PASS' "Loaded from $configSource"
} else {
  Add-Check 'config_present' 'FAIL' 'Neither TUNA_SUPABASE_URL/TUNA_SUPABASE_ANON_KEY nor config\local.json (copy config\local.example.json) provide both values.'
}

# --- 2. .gitignore actually covers config\local.json -----------------------
$gitignorePath = Join-Path $repoRoot '.gitignore'
if (Test-Path -LiteralPath $gitignorePath) {
  $gi = Get-Content -LiteralPath $gitignorePath -Raw
  if ($gi -match [regex]::Escape('config/local.json')) {
    Add-Check 'gitignore_covers_config' 'PASS' 'config/local.json is listed in .gitignore'
  } else {
    Add-Check 'gitignore_covers_config' 'FAIL' 'config/local.json is NOT listed in .gitignore - real keys could be committed'
  }
} else {
  Add-Check 'gitignore_covers_config' 'WARN' '.gitignore not found'
}

# --- 3. service_role never present anywhere in the app config templates ----
# Checks actual JSON KEYS only (not the whole file as text) - the example
# template's own cautionary comment mentions the word "service_role" on
# purpose, which a raw text/regex scan would wrongly flag as a finding.
$serviceRoleFound = $false
foreach ($f in @($configPath, $examplePath)) {
  if (Test-Path -LiteralPath $f) {
    try {
      $parsed = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
      $suspiciousKeys = $parsed.PSObject.Properties.Name | Where-Object { $_ -match '(?i)service.?role|secret' }
      if ($suspiciousKeys) { $serviceRoleFound = $true }
    } catch {
      # not valid JSON - already reported by config_file_parses above
    }
  }
}
Add-Check 'no_service_role_in_config' ($(if ($serviceRoleFound) { 'FAIL' } else { 'PASS' })) $(if ($serviceRoleFound) { 'A service_role/secret-named FIELD was found in a config file - remove it, the app never needs it.' } else { 'No service_role/secret key field present in any config file.' })

# --- 4. URL format -----------------------------------------------------------
if ($url) {
  if ($url -match '^https://[a-z0-9-]+\.supabase\.co/?$') {
    Add-Check 'url_format' 'PASS' $url
  } else {
    Add-Check 'url_format' 'WARN' "URL is present but doesn't match the expected https://<ref>.supabase.co shape: $url"
  }
} else {
  Add-Check 'url_format' 'FAIL' 'No URL to check.'
}

# --- 5. anon key presence/shape (never print the value) --------------------
if ($anonKey) {
  $looksLikeJwt = $anonKey -match '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  Add-Check 'anon_key_present' $(if ($looksLikeJwt) { 'PASS' } else { 'WARN' }) "length=$($anonKey.Length), jwt-shaped=$looksLikeJwt (value never printed)"
} else {
  Add-Check 'anon_key_present' 'FAIL' 'No anon key to check.'
}

# --- 6. Migration file readiness -------------------------------------------
$migrationPath = Join-Path $repoRoot 'supabase\migrations\0001_init.sql'
if (Test-Path -LiteralPath $migrationPath) {
  $sql = Get-Content -LiteralPath $migrationPath -Raw
  $hasRls = $sql -match 'enable row level security'
  $hasDestructive = $sql -match '(?i)drop\s+table(?!\s+if\s+not)|drop\s+database'
  if ($hasRls -and -not $hasDestructive) {
    Add-Check 'migration_file' 'PASS' "$migrationPath present, RLS enabled, no destructive statements"
  } else {
    Add-Check 'migration_file' 'WARN' "hasRls=$hasRls hasDestructiveDrop=$hasDestructive - review before running"
  }
} else {
  Add-Check 'migration_file' 'FAIL' "$migrationPath not found"
}

# --- 7. Live connectivity / schema / RLS smoke tests (only if configured) --
if ($url -and $anonKey) {
  $headers = @{ apikey = $anonKey; Authorization = "Bearer $anonKey" }
  try {
    $resp = Invoke-WebRequest -Uri "$url/rest/v1/" -Headers $headers -Method Get -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
    Add-Check 'connectivity' 'PASS' "REST endpoint responded, HTTP $($resp.StatusCode)"
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status) {
      Add-Check 'connectivity' 'PASS' "REST endpoint reachable (HTTP $status - an error status here still proves the project exists and responds)"
    } else {
      Add-Check 'connectivity' 'FAIL' "No response from $url - project may not exist yet, or the URL is wrong: $($_.Exception.Message)"
    }
  }

  foreach ($table in @('lists', 'tasks', 'user_settings')) {
    try {
      $resp = Invoke-WebRequest -Uri "$url/rest/v1/${table}?limit=1" -Headers $headers -Method Get -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
      $body = $resp.Content | ConvertFrom-Json
      $rlsOk = ($body -is [array]) -and ($body.Count -eq 0)
      Add-Check "schema_$table" 'PASS' 'Table exists and is reachable'
      Add-Check "rls_anon_$table" $(if ($rlsOk) { 'PASS' } else { 'WARN' }) $(if ($rlsOk) { 'Anonymous request returned zero rows, as expected with RLS + no anon policy' } else { "Anonymous request returned $($body.Count) row(s) - RLS should return none for an unauthenticated request; investigate" })
    } catch {
      $status = $null
      if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
      if ($status -eq 404 -or $status -eq 400) {
        Add-Check "schema_$table" 'FAIL' "Table '$table' not found (HTTP $status) - migration may not be applied yet"
      } else {
        Add-Check "schema_$table" 'WARN' "Could not verify '$table': $($_.Exception.Message)"
      }
    }
  }
} else {
  Add-Check 'connectivity' 'SKIP' 'No config - nothing to connect to yet'
  Add-Check 'schema_lists' 'SKIP' 'No config'
  Add-Check 'schema_tasks' 'SKIP' 'No config'
  Add-Check 'schema_user_settings' 'SKIP' 'No config'
}

# --- Report ------------------------------------------------------------------
$overall = if ($checks | Where-Object Status -eq 'FAIL') { 'FAIL' } elseif ($checks | Where-Object Status -eq 'WARN') { 'PASS_WITH_WARNINGS' } else { 'PASS' }

if ($Json) {
  [pscustomobject]@{ Overall = $overall; Checks = $checks } | ConvertTo-Json -Depth 4
} else {
  Write-Output "SUPABASE CLOUD BOOTSTRAP READINESS"
  Write-Output "==================================="
  foreach ($c in $checks) {
    Write-Output ("{0,-28} {1,-6} {2}" -f $c.Check, $c.Status, $c.Detail)
  }
  Write-Output "-----------------------------------"
  Write-Output "OVERALL: $overall"
  if ($overall -eq 'FAIL' -and -not ($url -and $anonKey)) {
    Write-Output ""
    Write-Output "Next step: create a free Supabase project (supabase.com/dashboard),"
    Write-Output "copy config\local.example.json to config\local.json, fill in the"
    Write-Output "Project URL + anon/public key from Project Settings > API, run"
    Write-Output "supabase\migrations\0001_init.sql once in that project's SQL editor,"
    Write-Output "then re-run this script."
  }
}

exit $(if ($overall -eq 'FAIL') { 1 } else { 0 })
