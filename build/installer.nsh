!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Your voice, ready anywhere"
  !define MUI_WELCOMEPAGE_TEXT "Set up Voxden, a private dictation workspace built for Windows.$\r$\n$\r$\nPress Ctrl+Shift+Space in any app to speak. Your words are transcribed locally and pasted where you were working.$\r$\n$\r$\nNo account. No telemetry. No API key."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "You're ready to speak"
  !define MUI_FINISHPAGE_TEXT "Voxden is installed and ready.$\r$\n$\r$\nPress Ctrl+Shift+Space in any app to start dictating. You can change the shortcut, microphone, and speech engine later in Settings."

  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove Voxden"
  !define MUI_WELCOMEPAGE_TEXT "This will remove the Voxden app from your computer.$\r$\n$\r$\nYour dictation history and local preferences are kept on this PC. You can remove them separately from Voxden's data folder."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; --- 1.0.19 only: leftover local language-pack cleanup ---
; Delete this entire leftover-writer block (vars, page, functions, and
; customInstall) when cutting 1.0.20.
; Keep src/main.js tidyModelStorage() writer deletion — users who skip 1.0.19
; still need it.
;
; Functions and vars live in installer-only macros because electron-builder
; includes this file before MUI2/LogicLib, and the uninstaller pass treats
; unused vars as errors.

!ifndef BUILD_UNINSTALLER
Var WriterDir
Var WriterExists
Var WriterDialog
Var WriterLabel
!endif

!macro customPageAfterChangeDir
  Function DetectWriterLeftover
    StrCpy $WriterDir "$APPDATA\Voxden\models\writer"
    StrCpy $WriterExists "0"
    ${If} ${FileExists} "$WriterDir\*.*"
      StrCpy $WriterExists "1"
    ${ElseIf} ${FileExists} "$WriterDir"
      StrCpy $WriterExists "1"
    ${EndIf}
  FunctionEnd

  Function WriterCleanupPageCreate
    Call DetectWriterLeftover
    ${If} $WriterExists != "1"
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Remove leftover local engine" "This language model is no longer used"

    nsDialogs::Create 1018
    Pop $WriterDialog
    ${If} $WriterDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 120u "The local sentence-correction engine has been removed from Voxden.$\r$\n$\r$\nLeftover language-pack files (up to about 2.5 GB) are still on this PC in File Explorer, and nothing will use them. Removing them is required to free that disk space.$\r$\n$\r$\nThese files will be deleted from:$\r$\n$WriterDir"
    Pop $WriterLabel

    nsDialogs::Show
  FunctionEnd

  Page custom WriterCleanupPageCreate
!macroend

!macro customInstall
  IfFileExists "$APPDATA\Voxden\models\writer\*.*" 0 skip_writer_files
    RMDir /r "$APPDATA\Voxden\models\writer"
    Goto skip_writer_dir
  skip_writer_files:
  IfFileExists "$APPDATA\Voxden\models\writer" 0 skip_writer_dir
    RMDir /r "$APPDATA\Voxden\models\writer"
  skip_writer_dir:
  Delete "$APPDATA\Voxden\data\local-correction.log"
!macroend
