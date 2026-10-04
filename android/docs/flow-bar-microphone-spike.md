# Flow bar spike: may the accessibility service record in the background?

Date: 2026-10-04. Device: emulator-5554, Android 16 (API 36) Google Play AVD `medium_phone`, app `com.voxden.android.debug`, targetSdk 36.
Method: the accessibility service was enabled with `settings put secure enabled_accessibility_services ...`, the Settings app was brought to the front (`am start -a android.settings.SETTINGS`, confirmed as `topResumedActivity`; no Voxden activity existed), and debug probes were triggered by `am broadcast` into a runtime receiver in the service. Probe source is kept in `flowbar-notes/FlowBarSpike.kt.txt` (the probes are not in the shipped code).

## Result: yes. All three paths work from the accessibility service. No fallback was needed on this device.

| Probe | Result |
|---|---|
| (a) `AudioRecord` (VOICE_RECOGNITION, 16 kHz) started from the service | `state=INITIALIZED`, `recordingState=RECORDING`, `read` returned 51 200 bytes of which 41 462 were non-zero, `AudioRecordingConfiguration.isClientSilenced = false`, `dumpsys audio`: `rec update ... src:VOICE_RECOGNITION not silenced pack:com.voxden.android.debug`. |
| (b) `AppController.startRecording(DictationSource.FLOW_BAR, target)` with the phone speech engine | Returned `true`, `phase=RECORDING`, no error. The recognizer host (`com.google.android.tts`) opened the microphone for us (`triggerApplicationId: com.voxden.android.debug`, `onMicrophoneOpened`, `onStartOfSpeech`), `silenced=false`, `audioLevel` rose 0.0 -> 0.1 -> 0.18. No `ERROR_INSUFFICIENT_PERMISSIONS` / `ERROR_CLIENT`. The only recogniser error in the log is the unrelated `Failed to get language pack of required locale: error 13` (offline pack missing). |
| (c) `MicrophoneService.start(ctx)` from the service | Did not throw. `ActivityManager: Background started FGS: Allowed [callingPackage: com.voxden.android.debug; uidState: BFGS; uidBFSL: [BFSL]; ... allowWiu:52]`. `dumpsys activity services`: `isForeground=true foregroundId=202 types=0x80` (microphone). The dictation started after it (`startRecording=true`), not silenced. |

## Why it works (observed, not assumed)

`dumpsys activity processes` for the service's process: `curProcState=BFGS`, `curCapability=LCMNFUAT` (includes the microphone capability `M`). The system binds an accessibility service with the foreground-service bind flag, so while the service is enabled its process is a "bound foreground service" and holds the while-in-use microphone capability. `dumpsys activity services` also shows `mIsAllowedBgActivityStartsByBinding=true` for the service, so it may start activities from the background (used for "open the app" when the microphone permission is missing and for the hand-off fallback).

## Control (proves the probe can fail)

The same `AudioRecord` probe run from a plain manifest receiver in the same app with the accessibility service **disabled** and Settings in front: `AppOpsManager.unsafeCheckOpNoThrow(OPSTR_RECORD_AUDIO, uid, pkg)` = `MODE_IGNORED (1)`, `read` returned 51 200 bytes, **0 non-zero**, `isClientSilenced = true`, `dumpsys audio`: `... silenced pack:com.voxden.android.debug`. With the service enabled the same appop check returns `MODE_ALLOWED (0)`.

So: a visible overlay is not what grants the microphone; the enabled accessibility service is. And the appop check is a reliable, cheap, pre-flight test of "may this process record right now".

## What shipped because of this

- The flow bar starts dictation straight from the service (`AppController.startRecording`), no foreground service and no activity, so there is no notification and no flicker over the target app. `MicrophoneService` is therefore **not** used by the flow bar on this path (it would only add a notification).
- Safety net for devices where a maker does not grant the capability. Two triggers, both in `DictationFlow`: (1) before starting, `MicAccess.canRecordNow` (the appop check above) is anything but ALLOWED; (2) after starting, within 5 s, the controller reports a microphone refusal while the runtime permission is granted (`ERROR_INSUFFICIENT_PERMISSIONS`, or a `SecurityException` from the cloud recorder). Either way the flow bar tries `MicHandoffActivity` exactly once: a translucent, animation-less activity started from the service that starts `MicrophoneService` and then `AppController.startRecording(FLOW_BAR, target)` on the same main-loop pass (the contract `MicrophoneService` relies on), then finishes at once.
- Trigger (2) is by message class (`classifyError` in `FlowBarLogic.kt`) and is covered by unit tests, but I could not produce a real refusal on this emulator, so the retry itself was exercised only through trigger (1) forced with the debug switch `FORCE_HANDOFF`.

## Hand-off results (forced on emulator-5554, API 36)

- `MicHandoffActivity` is started from the accessibility service with FLAG_ACTIVITY_NEW_TASK: allowed (`BAL_ALLOW_PERMISSION` in the activity manager log; the service holds the background-activity-start exemption by binding).
- With the activity's window left focusable, 2 of about 9 runs of the device test came back with the field still focused but the keyboard gone (the same symptom also appeared, without any hand-off, in a few runs where the emulator's keyboard simply failed to draw, so the share caused by the hand-off is unknown). With `FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCHABLE` on the activity window the target app keeps its window focus, and `FlowBarDeviceTest.theHandoffActivityStartsTheDictationAndTheFieldKeepsItsFocus` passed 6 of 6 consecutive runs: field focused, keyboard up, a live input connection, and the dictated text typed into the same field afterwards. Manual run in Settings search: same result, keyboard never left.
- `MicrophoneService` was foreground (`types=0x80`) for the dictation and stopped itself when the dictation ended.

## Not covered by the spike

- Real OEM devices (Samsung, Xiaomi, etc.): only AOSP behaviour was observed. The fallback exists for the others.
- Another app holding the microphone, a phone call, and Bluetooth routing.
- Android 12 and older: not run (the only AVD is API 36). The input-connection path needs API 33; the node fallbacks (`ACTION_SET_TEXT`, `ACTION_PASTE`) were exercised on API 36 by forcing them.
