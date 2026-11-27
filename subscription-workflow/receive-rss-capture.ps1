#Requires -Version 7
param(
    [Parameter(Mandatory)][ValidatePattern('^scheduled-\d{4}-\d{2}-\d{2}$')][string]$Cycle,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$MacHost,
    [Parameter(Mandatory)][ValidatePattern('^/[A-Za-z0-9/._-]+$')][string]$MacHome,
    [Parameter(Mandatory)][string]$SubscriptionsHome,
    [Parameter(Mandatory)][string]$Node,
    [ValidatePattern('^/[A-Za-z0-9/._-]+$')][string]$MacStage,
    [switch]$Acknowledge
)
$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'remote-feed-stage.mjs'
$sshOptions = @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10')
$repo = "$MacHome/Agent/Projects/progressive-reading-workflow"
$macData = if ($MacStage) { $MacStage } else { "$MacHome/Agent/AppData/ProgressiveReading/SubscriptionFeedCapture" }
$remote = "$MacHome/.local/bin/node $repo/subscription-workflow/remote-feed-stage.mjs"
$target = Join-Path $SubscriptionsHome "remote-rss/$Cycle"
$destination = Join-Path $target 'capture.json'
$registry = Join-Path $SubscriptionsHome 'subscriptions.json'

function Verify-Capture([string]$File) {
    $json = & $Node $cli verify $SubscriptionsHome $Cycle $File $registry
    if ($LASTEXITCODE -ne 0) { throw 'Captured RSS input was not verified.' }
    $json | ConvertFrom-Json
}

if ($Acknowledge) {
    $verified = Verify-Capture $destination
    $jobId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes("rss:$Cycle"))).ToLowerInvariant().Substring(0,32)
    $job = Get-Content -Raw -LiteralPath (Join-Path $SubscriptionsHome "jobs/$jobId.json") | ConvertFrom-Json
    if ($job.id -ne $jobId -or $job.kind -ne 'rss' -or $job.cycle -ne $Cycle -or
        $job.status -notin @('completed','completed_with_issues') -or $job.steps.scan.result.remoteCapture.sha256 -ne $verified.sha256) {
        throw 'The original Windows job has not recorded consumption of this capture.'
    }
    $observed = & ssh @sshOptions $MacHost "$remote consumed $macData $Cycle"
    if ($LASTEXITCODE -ne 0) { throw 'Consumption state could not be read from the Mac.' }
    if ($observed -ne 'null') {
        $receipt = $observed | ConvertFrom-Json
        if ($receipt.sha256 -ne $verified.sha256 -or $receipt.jobId -ne $jobId) { throw 'Consumption receipt conflicts with the Windows job.' }
        $observed
        return
    }
    & ssh @sshOptions $MacHost "$remote ack $macData $Cycle $($verified.sha256) $jobId"
    if ($LASTEXITCODE -ne 0) { throw 'Consumption acknowledgement outcome is unknown. Repeat this command to read its stored result.' }
    return
}

if (Test-Path -LiteralPath $destination) {
    Verify-Capture $destination
    return
}
$observed = & ssh @sshOptions $MacHost "$remote status $macData $Cycle"
if ($LASTEXITCODE -ne 0) { throw 'Mac capture status could not be read.' }
$receipt = $observed | ConvertFrom-Json
if (!$receipt -or $receipt.status -notin @('completed','completed_with_issues') -or $receipt.cycle -ne $Cycle) {
    throw 'A completed Mac capture is unavailable for this cycle.'
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
$temporary = Join-Path $target ([guid]::NewGuid().ToString('N') + '.partial')
try {
    & scp -B @sshOptions "${MacHost}:$macData/$Cycle/capture.json" $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Mac capture download failed.' }
    $verified = Verify-Capture $temporary
    if ($verified.sha256 -ne $receipt.sha256) { throw 'Downloaded capture does not match its receipt.' }
    try {
        [IO.File]::Move($temporary, $destination)
    } catch [IO.IOException] {
        if (!(Test-Path -LiteralPath $destination)) { throw }
        if ((Verify-Capture $destination).sha256 -ne $verified.sha256) { throw 'Concurrent capture differs.' }
    }
    $verified
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
