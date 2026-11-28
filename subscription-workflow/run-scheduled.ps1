#Requires -Version 7.0
param([Parameter(Mandatory=$true)][ValidateSet('rss','bilibili','zhihu','daily','weekly')][string]$Kind,[string]$WorkflowRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = if ($WorkflowRoot) { (Resolve-Path -LiteralPath $WorkflowRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$logRoot = 'D:\Artifacts\ProgressiveReading\subscriptions\logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = Join-Path $logRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Kind + '.log')
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Node runtime missing' }
Set-Location -LiteralPath $projectRoot
$localDate = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$cycle = "scheduled-$localDate"
$subscriptionHome = if ($env:PROGRESSIVE_READING_SUBSCRIPTIONS_HOME) {
    $env:PROGRESSIVE_READING_SUBSCRIPTIONS_HOME
} else { 'D:\AppData\ProgressiveReading\Subscriptions' }
$bindingFile = Join-Path $subscriptionHome 'remote-rss-binding.json'
$receivedCapture = $false
if ($Kind -eq 'rss' -and (Test-Path -LiteralPath $bindingFile)) {
    $binding = Get-Content -Raw -LiteralPath $bindingFile | ConvertFrom-Json
    if ($binding.enabled -eq $true) {
        $receiver = Join-Path $PSScriptRoot 'receive-rss-capture.ps1'
        $remoteArgs = @{ MacHost = $binding.host; MacHome = $binding.home; SubscriptionsHome = $subscriptionHome; Node = $node }
        $previousCycle = 'scheduled-' + [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).AddDays(-1).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        if (Test-Path -LiteralPath (Join-Path $subscriptionHome "remote-rss/$previousCycle/capture.json")) {
            try { & $receiver @remoteArgs -Cycle $previousCycle -Acknowledge | Out-Null }
            catch { "Previous RSS acknowledgement remains pending." | Tee-Object -FilePath $log -Append }
        }
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(100)
        do {
            try {
                $captured = & $receiver @remoteArgs -Cycle $cycle
                if (!$captured.sha256) { throw 'RSS capture hash is missing.' }
                $receivedCapture = $true
                "Mac RSS capture ready for $cycle." | Tee-Object -FilePath $log -Append
                break
            } catch {
                if ([DateTimeOffset]::UtcNow -ge $deadline) {
                    "Mac RSS capture unavailable for $cycle. The existing local source path will run." |
                        Tee-Object -FilePath $log -Append
                    break
                }
                Start-Sleep -Seconds 5
            }
        } while ($true)
    }
}
$cli = Join-Path $PSScriptRoot 'cli.mjs'
if ($Kind -in @('zhihu','bilibili')) {
    & $node $cli enqueue-discovery --root $projectRoot --kind $Kind 2>&1 | Tee-Object -FilePath $log -Append
} elseif ($WorkflowRoot -and $Kind -in @('rss','daily','weekly')) {
    # Claim the original scheduled job under the existing worker lock before the local app can take it.
    $run = if($Kind -eq 'rss') {'run-scheduled-rss'} else {'run-scheduled-report'}
    $period = if($Kind -eq 'rss') {$cycle} else {'natural'}
    & $node $cli $run --root $projectRoot --kind $Kind --key $period 2>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) {
        # A busy worker can continue from the original queue without risking a second cycle.
        $fallback = if($Kind -eq 'rss') {'enqueue'} else {'enqueue-scheduled-report'}
        & $node $cli $fallback --root $projectRoot --kind $Kind --key $period 2>&1 | Tee-Object -FilePath $log -Append
    }
} else {
    & $node $cli enqueue --root $projectRoot --kind $Kind --key $cycle 2>&1 | Tee-Object -FilePath $log -Append
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$service = Get-ScheduledTask -TaskName 'Local IR Browser Highlight' -ErrorAction Stop
if ($service.State -ne 'Running') { Start-ScheduledTask -TaskName $service.TaskName }

if ($receivedCapture) {
    $jobId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes("rss:$cycle"))).ToLowerInvariant().Substring(0,32)
    $jobFile = Join-Path $subscriptionHome "jobs/$jobId.json"
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(12)
    do {
        $job = if (Test-Path -LiteralPath $jobFile) { Get-Content -Raw -LiteralPath $jobFile | ConvertFrom-Json }
        if ($job.status -in @('completed','completed_with_issues')) {
            try { & $receiver @remoteArgs -Cycle $cycle -Acknowledge | Tee-Object -FilePath $log -Append }
            catch { "RSS consumption acknowledgement pending. It will be rechecked on the next trigger." | Tee-Object -FilePath $log -Append }
            break
        }
        if ($job.status -eq 'failed' -or [DateTimeOffset]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 8
    } while ($true)
}
