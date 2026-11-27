#Requires -Version 7.0
param(
    [ValidateSet('Install','Status')][string]$Action='Status',
    [string]$PythonwPath = (Join-Path $env:LOCALAPPDATA 'Python\pythoncore-3.14-64\pythonw.exe')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$definitions = @(
    @{Name='ProgressiveReading-RSS-Source';Kind='rss';Time='06:00'},
    @{Name='ProgressiveReading-Zhihu-Source';Kind='zhihu';Time='07:00'},
    @{Name='ProgressiveReading-VideoWatch-Daily';Kind='bilibili';Time='08:00'},
    @{Name='ProgressiveReading-RSS-Daily';Kind='daily';Time='09:00'},
    @{Name='ProgressiveReading-RSS-Weekly';Kind='weekly';Time='21:00'}
)
if ($Action -eq 'Install') {
    if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'Beijing scheduling requires explicit timezone conversion on this host' }
    $pythonw = (Resolve-Path -LiteralPath $PythonwPath).Path
    if ([IO.Path]::GetFileName($pythonw) -ine 'pythonw.exe') { throw 'Use the windowless Python executable (pythonw.exe)' }
    $launcher = (Resolve-Path -LiteralPath 'D:\Projects\DeveloperGovernance\run-hidden.pyw').Path
    $backup = Join-Path 'D:\Artifacts\ProgressiveReading\subscriptions-20261106\schedule-before' (Get-Date -Format 'yyyyMMdd-HHmmss')
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $plan = foreach ($definition in $definitions) {
        $existing = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
        $workingDirectory = $projectRoot
        $shell = $pwsh
        $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Kind {1}' -f (Join-Path $PSScriptRoot 'run-scheduled.ps1'), $definition.Kind
        if ($existing) {
            if ($existing.State -eq 'Running') { throw "Task still running: $($definition.Name)" }
            if (@($existing.Actions).Count -ne 1) { throw "Expected one action: $($definition.Name)" }
            $current = $existing.Actions[0]
            $workingDirectory = $current.WorkingDirectory
            $shell = $current.Execute
            $arguments = $current.Arguments
            $wrapped = '^"{0}" --no-timeout -- "(?<shell>[^"]+)" (?<arguments>.+)$' -f [regex]::Escape($launcher)
            if ([IO.Path]::GetFileName($shell) -ieq 'pythonw.exe' -and $arguments -match $wrapped) {
                $shell = $Matches.shell
                $arguments = $Matches.arguments
            }
            if (!$workingDirectory -or [IO.Path]::GetFullPath($workingDirectory) -ine $projectRoot -or
                [IO.Path]::GetFileName($shell) -ine 'pwsh.exe' -or !(Test-Path -LiteralPath $shell -PathType Leaf) -or
                $arguments -notmatch '^[^"]*-File "(?<script>[^"]+)" -Kind (?<kind>\w+)(?: -WorkflowRoot "(?<root>[^"]+)")?$') {
                throw "Task ownership mismatch: $($definition.Name)"
            }
            $runtimeName = switch ($definition.Kind) {
                'rss' { 'ScheduledRssRuntime' }
                { $_ -in 'daily','weekly' } { 'ScheduledReportsRuntime' }
            }
            $expected = Join-Path $PSScriptRoot 'run-scheduled.ps1'
            $bound = if ($runtimeName) {
                Join-Path 'D:\AppData\ProgressiveReading' "$runtimeName\subscription-workflow\run-scheduled.ps1"
            }
            $file = [IO.Path]::GetFullPath($Matches.script)
            $boundRoot = $Matches.root
            if ($Matches.kind -ine $definition.Kind -or !(Test-Path -LiteralPath $file -PathType Leaf) -or
                ($file -ine $expected -and (!$bound -or $file -ine $bound -or !$boundRoot)) -or
                ($boundRoot -and [IO.Path]::GetFullPath($boundRoot) -ine $projectRoot)) {
                throw "Unexpected subscription runtime: $($definition.Name)"
            }
        }
        $hiddenArguments = '"{0}" --no-timeout -- "{1}" {2}' -f $launcher,$shell,$arguments
        if (!$existing -or $current.Execute -ine $pythonw -or $current.Arguments -cne $hiddenArguments) {
            [pscustomobject]@{
                Definition = $definition; Existing = $existing
                Action = New-ScheduledTaskAction -Execute $pythonw -Argument $hiddenArguments -WorkingDirectory $workingDirectory
            }
        }
    }
    foreach ($entry in $plan | Where-Object Existing) {
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Export-ScheduledTask -TaskName $entry.Definition.Name | Set-Content -LiteralPath (Join-Path $backup ($entry.Definition.Name + '.xml')) -Encoding utf8
    }
    foreach ($entry in $plan) {
        $definition = $entry.Definition
        if ($entry.Existing) {
            if ((Get-ScheduledTask -TaskName $definition.Name).State -eq 'Running') { throw "Task still running: $($definition.Name)" }
            Set-ScheduledTask -TaskName $definition.Name -Action $entry.Action | Out-Null
        } else {
            $trigger = if ($definition.Kind -eq 'weekly') { New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At $definition.Time } else { New-ScheduledTaskTrigger -Daily -At $definition.Time }
            Register-ScheduledTask -TaskName $definition.Name -Action $entry.Action -Trigger $trigger -Principal $principal -Settings $settings -Description "Unified subscriptions: $($definition.Kind), Beijing $($definition.Time)" | Out-Null
        }
    }
}
foreach ($definition in $definitions) {
    $task = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $definition.Name
        [pscustomobject]@{name=$task.TaskName;enabled=$task.Settings.Enabled;state=[string]$task.State;next_run=$info.NextRunTime;executable=$task.Actions.Execute;arguments=$task.Actions.Arguments} | ConvertTo-Json -Compress
    }
}
