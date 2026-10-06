# Waits for a process to exit. If it is still running after -Seconds, prints
# its windows (a modal error box among them, with its text) and its child
# processes, then ends it. test-packaged-startup.js starts this as it quits,
# because a main thread stuck behind a native box runs no timer of its own.
param([int]$Id, [int]$Seconds = 25)
$ErrorActionPreference = 'SilentlyContinue'
Wait-Process -Id $Id -Timeout $Seconds
if (-not (Get-Process -Id $Id)) { exit 0 }
Write-Output "Quit watchdog: process $Id is still running after $Seconds s"
Add-Type -AssemblyName UIAutomationClient
$auto = [System.Windows.Automation.AutomationElement]
$mine = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $Id)
foreach ($window in $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {
  Write-Output ("window " + $window.Current.ClassName + ": " + $window.Current.Name)
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($part in $all) {
    if ($part.Current.Name) { Write-Output ("  " + $part.Current.ControlType.ProgrammaticName + ": " + $part.Current.Name) }
  }
}
Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id" | ForEach-Object {
  $kind = [regex]::Match([string]$_.CommandLine, '--(utility-sub-)?type=\S+').Value
  if (-not $kind) { $kind = ([string]$_.CommandLine).Substring(0, [Math]::Min(160, ([string]$_.CommandLine).Length)) }
  Write-Output ("child " + $_.ProcessId + " " + $_.Name + " " + $kind)
}
Stop-Process -Id $Id -Force
exit 1
