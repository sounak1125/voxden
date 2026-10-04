[CmdletBinding()]
param(
    [switch]$NoBuild,
    [string]$Device,
    [string]$Avd = 'medium_phone'
)
$ErrorActionPreference = 'Stop'
$taskAndroidRoot = $PSScriptRoot
$taskSdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$taskAdb = Join-Path $taskSdk 'platform-tools\adb.exe'
$taskEmulator = Join-Path $taskSdk 'emulator\emulator.exe'
if (!(Test-Path -LiteralPath $taskAdb)) { throw "Android SDK not found at $taskSdk. Install Android Studio and SDK Platform 36, then set ANDROID_HOME." }
if (!(Test-Path -LiteralPath (Join-Path $taskAndroidRoot 'local.properties'))) {
    Set-Content -LiteralPath (Join-Path $taskAndroidRoot 'local.properties') -Value ('sdk.dir=' + $taskSdk.Replace('\','/').Replace(':','\:')) -Encoding ascii
}
if (!$NoBuild) {
    & (Join-Path $taskAndroidRoot 'gradlew.bat') -p $taskAndroidRoot :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed. See Gradle output above.' }
}
$taskApk = Join-Path $taskAndroidRoot 'app\build\outputs\apk\debug\app-debug.apk'
if (!(Test-Path -LiteralPath $taskApk)) { throw 'APK missing. Run without -NoBuild first.' }
$taskDevices = @(& $taskAdb devices | Select-String '^([^\s]+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
if (!$Device) {
    if ($taskDevices.Count -gt 1) { throw "Multiple devices connected. Choose one with -Device SERIAL: $($taskDevices -join ', ')" }
    if ($taskDevices.Count -eq 1) { $Device = $taskDevices[0] }
    else {
        if (!(Test-Path -LiteralPath $taskEmulator)) { throw 'Android Emulator is not installed.' }
        $taskAvds = @(& $taskEmulator -list-avds)
        if ($taskAvds -notcontains $Avd) { throw "AVD '$Avd' not found. Create an Android 16 Google Play virtual device in Android Studio, or use -Avd NAME. Available: $($taskAvds -join ', ')" }
        Write-Host "Starting $Avd. The Android window will stay open for testing."
        Start-Process -FilePath $taskEmulator -ArgumentList '-avd', $Avd, '-no-snapshot-load'
        $taskDeadline = (Get-Date).AddMinutes(3)
        do {
            Start-Sleep -Seconds 2
            $taskDevices = @(& $taskAdb devices | Select-String '^(emulator-\d+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
        } until ($taskDevices.Count -gt 0 -or (Get-Date) -gt $taskDeadline)
        if (!$taskDevices.Count) { throw 'Emulator did not become available within three minutes.' }
        $Device = $taskDevices[0]
    }
}
$taskDeadline = (Get-Date).AddMinutes(3)
do {
    $taskBooted = (& $taskAdb -s $Device shell getprop sys.boot_completed 2>$null | Out-String).Trim()
    if ($taskBooted -ne '1') { Start-Sleep -Seconds 2 }
} until ($taskBooted -eq '1' -or (Get-Date) -gt $taskDeadline)
if ($taskBooted -ne '1') { throw "Device $Device did not finish booting." }
if ($Device -like 'emulator-*') {
    # The desktop keyboard otherwise suppresses the voice IME's on-screen controls.
    & $taskAdb -s $Device shell settings put secure show_ime_with_hard_keyboard 1
}
& $taskAdb -s $Device install -r $taskApk
if ($LASTEXITCODE -ne 0) { throw 'Could not install Voxden.' }
& $taskAdb -s $Device shell am start -n 'com.voxden.android.debug/com.voxden.android.MainActivity'
if ($LASTEXITCODE -ne 0) { throw 'Could not launch Voxden.' }
Write-Host "Voxden is ready on $Device. For emulator voice input, enable host microphone in Extended controls > Microphone."
