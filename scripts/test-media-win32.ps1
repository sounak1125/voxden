$ErrorActionPreference = 'Stop'

# Load only the media function bodies and switch branches from production.
# Never load user32 or real WinRT sessions: every player below is a fake.
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'win32.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$names = @('Invoke-VoxdenMediaPause', 'Invoke-VoxdenMediaResume')
foreach ($fn in $ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names
}, $true)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}
$actions = @{}
foreach ($statement in $ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.SwitchStatementAst]
}, $true)) {
  foreach ($clause in $statement.Clauses) {
    if ($clause.Item1.Value -in @('media-pause', 'media-resume')) {
      $body = $clause.Item2.Extent.Text
      $actions[$clause.Item1.Value] = [scriptblock]::Create($body.Substring(1, $body.Length - 2))
    }
  }
}
if ($actions.Count -ne 2) { throw 'Media actions were not found' }

function Get-VoxdenMediaManager { return $script:manager }
function Wait-WinRTOp { param($Op, [Type]$ResultType); return $Op }
$script:VoxdenEndpointReceiptPrefix = '__endpoint__:'
$script:endpointPauseReceipts = @()
$script:endpointRestoreReceipts = @()
function Invoke-VoxdenEndpointMute { return @($script:endpointPauseReceipts) }
function Invoke-VoxdenEndpointRestore {
  param([string[]]$Receipts)
  $script:endpointRestoreReceipts += ,@($Receipts)
}
function Assert-Equal($Name, $Actual, $Expected) {
  if (($Actual | ConvertTo-Json -Compress) -ne ($Expected | ConvertTo-Json -Compress)) {
    throw "$Name : expected $Expected, got $Actual"
  }
  Write-Output "ok $Name"
}
function New-Player($Id, $Status, $PauseWorks = $true) {
  $player = [pscustomobject]@{ SourceAppUserModelId = $Id; Status = $Status;
    PauseWorks = $PauseWorks; PauseCalls = 0; PlayCalls = 0 }
  $player | Add-Member ScriptMethod GetPlaybackInfo { return [pscustomobject]@{PlaybackStatus = $this.Status} }
  $player | Add-Member ScriptMethod TryPauseAsync {
    $this.PauseCalls++
    if ($this.PauseWorks) { $this.Status = 'Paused' }
    return $this.PauseWorks
  }
  $player | Add-Member ScriptMethod TryPlayAsync {
    $this.PlayCalls++; $this.Status = 'Playing'; return $true
  }
  return $player
}
$script:manager = [pscustomobject]@{}
$script:manager | Add-Member ScriptMethod GetSessions { return $script:players }

$paused = New-Player 'paused' 'Paused'
$stopped = New-Player 'stopped' 'Stopped'
$script:players = @($paused, $stopped)
Assert-Equal 'already paused players produce no pause receipts' @(& $actions['media-pause']) @()
Assert-Equal 'paused player is left alone' $paused.Status 'Paused'
$script:players = @()
Assert-Equal 'no player does nothing (no global toggle)' @(& $actions['media-pause']) @()

$playing = New-Player 'playing' 'Playing'
$failed = New-Player 'failed' 'Playing' $false
$anonymous = New-Player '' 'Playing'
$endpointReceipt = '__endpoint__:ZGVmYXVsdC1zcGVha2Vycw=='
$script:endpointPauseReceipts = @($endpointReceipt)
$script:players = @($playing, $paused, $stopped, $failed, $anonymous)
$ids = @(& $actions['media-pause'])
Assert-Equal 'successful media and endpoint mutes are both owned' $ids @('playing', $endpointReceipt)
Assert-Equal 'playing music pauses' $playing.Status 'Paused'
Assert-Equal 'unidentifiable player is untouched' $anonymous.PauseCalls 0
$Ids = $ids -join ','
& $actions['media-resume']
Assert-Equal 'owned player resumes' $playing.PlayCalls 1
Assert-Equal 'owned endpoint is restored' $script:endpointRestoreReceipts[0] @($endpointReceipt)
Assert-Equal 'previously paused music never starts' $paused.PlayCalls 0
Assert-Equal 'failed pause is never restored' $failed.PlayCalls 0
$script:endpointPauseReceipts = @()
& $actions['media-resume']
Assert-Equal 'already playing media is not played again' $playing.PlayCalls 1
$Ids = 'stopped,__toggle__'
& $actions['media-resume']
Assert-Equal 'stopped music and obsolete toggle receipt do nothing' $stopped.PlayCalls 0

$tab1 = New-Player 'browser' 'Playing'
$tab2 = New-Player 'browser' 'Paused'
$script:players = @($tab1, $tab2)
Assert-Equal 'ambiguous browser tabs are not claimed by app ID' @(& $actions['media-pause']) @()
$Ids = 'browser'
& $actions['media-resume']
Assert-Equal 'a second tab with the same app ID cannot be started' $tab2.PlayCalls 0

$script:manager = $null
Assert-Equal 'unavailable Windows media API leaves playback untouched' @(& $actions['media-pause']) @()
& $actions['media-resume']
Write-Output 'all Windows media tests passed (mock players only)'
