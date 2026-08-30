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
