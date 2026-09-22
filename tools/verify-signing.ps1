#Requires -Version 5.1
<#
  verify-signing.ps1 - Release Hardening phase. Reports the real
  Authenticode signature status of the packaged Windows binaries using
  only Windows' own built-in Get-AuthenticodeSignature - no new
  dependency. Never asserts a certificate exists; reports UNSIGNED
  honestly when it doesn't (that is this project's current, expected
  state - see README).

  Usage:
    pwsh tools\verify-signing.ps1              # checks dist\ artifacts
    pwsh tools\verify-signing.ps1 -Require     # exit 1 if anything is not "Valid"
#>
[CmdletBinding()]
param(
  [switch]$Require
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$targets = @(
  (Join-Path $repoRoot 'dist\win-unpacked\Tuna Tastan.exe'),
  (Get-ChildItem (Join-Path $repoRoot 'dist') -Filter 'Tuna-Tastan-Setup-*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $targets) {
  Write-Output "No built artifacts found in dist\ - run npm run build first."
  exit 1
}

$results = @()
foreach ($t in $targets) {
  $sig = Get-AuthenticodeSignature -LiteralPath $t
  $results += [pscustomobject]@{
    File          = Split-Path -Leaf $t
    Status        = $sig.Status.ToString()          # NotSigned | Valid | HashMismatch | NotTrusted | ...
    SignerSubject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(none - unsigned)' }
    TimeStamped   = [bool]$sig.TimeStamperCertificate
  }
}

$results | Format-Table -AutoSize

$allValid = -not ($results | Where-Object { $_.Status -ne 'Valid' })
if ($allValid) {
  Write-Output "SIGNING: Valid (all checked binaries signed and verified)"
} else {
  Write-Output "SIGNING: UNSIGNED (this is the current expected state - no code signing certificate has been purchased; see README 'Code signing' section)"
}

if ($Require -and -not $allValid) { exit 1 }
exit 0
