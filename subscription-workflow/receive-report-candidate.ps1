#Requires -Version 7
param(
    [Parameter(Mandatory)][ValidatePattern('^scheduled-\d{4}-\d{2}-\d{2}$')][string]$Cycle,
    [Parameter(Mandatory)][ValidateSet('daily','weekly')][string]$Kind,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$MacHost,
    [Parameter(Mandatory)][ValidatePattern('^/[A-Za-z0-9/._-]+$')][string]$MacStage,
    [Parameter(Mandatory)][string]$CandidateHome
)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetFullPath($CandidateHome)) "remote-reports/$Cycle"
$target = Join-Path $root $Kind
$from = "${MacHost}:$MacStage/$Cycle/$Kind"
$options = @('-B','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10')

function Get-Candidate([string]$Directory) {
    $report = Get-Content -Raw -LiteralPath (Join-Path $Directory 'receipt.json') | ConvertFrom-Json
    if ($report.schema -ne 'progressive-reading.subscription-report-candidate/v1' -or
        $report.kind -ne $Kind -or $report.cycle -ne $Cycle -or
        $report.inputSha256 -notmatch '^[a-f0-9]{64}$' -or $report.publishable -ne $false) {
        throw 'Unexpected report candidate identity.'
    }
    $allowed = @('daily','long_weekly','short_weekly','ledger')
    foreach ($entry in $report.outputs.PSObject.Properties) {
        if ($entry.Name -notin $allowed -or $entry.Value.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Unexpected report candidate output.'
        }
    }
    $report
}

function Check-Files([string]$Directory, $Report) {
    foreach ($entry in $Report.outputs.PSObject.Properties) {
        $file = Join-Path $Directory ($entry.Name + '.stage')
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value.sha256) {
            throw 'A report candidate output failed checksum verification.'
        }
    }
}

if (Test-Path -LiteralPath $target) {
    $saved = Get-Candidate $target
    Check-Files $target $saved
    $saved
    return
}

New-Item -ItemType Directory -Path $root -Force | Out-Null
$incoming = Join-Path $root ('.incoming-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $incoming | Out-Null
& scp @options "$from/receipt.json" (Join-Path $incoming 'receipt.json')
if ($LASTEXITCODE -ne 0) { throw 'Remote report receipt is unavailable.' }
$receipt = Get-Candidate $incoming
foreach ($entry in $receipt.outputs.PSObject.Properties) {
    $relative = $entry.Value.file.Replace('\','/')
    if ($relative -notmatch '^work-[A-Za-z0-9]+/workspace/(摘要区/订阅/[^/]+\.md|阅读区/订阅/短文周报/[^/]+\.md|imports/rss-reading/review-ledger\.v1\.json)$' -or
        $relative -match '[\x00-\x1f:]') {
        throw 'Unexpected remote report path.'
    }
    & scp @options "$from/$relative" (Join-Path $incoming ($entry.Name + '.stage'))
    if ($LASTEXITCODE -ne 0) { throw 'A remote report candidate output was unavailable.' }
}
Check-Files $incoming $receipt
try {
    [IO.Directory]::Move($incoming, $target)
} catch [IO.IOException] {
    if (!(Test-Path -LiteralPath $target)) { throw }
    $existing = Get-Candidate $target
    Check-Files $target $existing
    $expected = (Get-FileHash -LiteralPath (Join-Path $incoming 'receipt.json')).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $target 'receipt.json')).Hash
    if ($actual -ne $expected) { throw 'A different report candidate already exists.' }
}
Get-Candidate $target
