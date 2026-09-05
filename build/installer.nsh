; Native fonts scale with Windows DPI. Do not bake lettering into installer BMPs.
SetFont "Segoe UI" 10

Var VoxdenSmallFont
Var VoxdenWordmarkFont
Var VoxdenTaglineFont
Var VoxdenTitleFont

!macro VoxdenCreateFont HANDLE POINTS WEIGHT FACE
  Push $0
  Push $1
  Push $2
  System::Call 'user32::GetDC(p $HWNDPARENT) p .r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 90) i .r1'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  System::Call 'kernel32::MulDiv(i ${POINTS}, i r1, i 72) i .r2'
  IntOp $2 0 - $2
  ; Grayscale antialiasing stays clean on the transparent dark-panel labels.
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 4, i 0, w "${FACE}") p .r0'
  StrCpy ${HANDLE} $0
  ${If} ${HANDLE} == 0
    CreateFont ${HANDLE} "${FACE}" ${POINTS} ${WEIGHT}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro VoxdenSidebarLabel COLOR FONT
  ${NSD_AddStyle} $0 ${SS_CENTER}
  ${NSD_AddExStyle} $0 ${WS_EX_TRANSPARENT}
  SetCtlColors $0 "${COLOR}" transparent
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  ; A bitmap otherwise covers later nsDialogs labels in the sibling Z order.
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x13)'
!macroend

!macro VoxdenSidebarText
  ; Cache handles across Back/Next navigation; the setup process owns them.
  ${If} $VoxdenSmallFont == ""
    !insertmacro VoxdenCreateFont $VoxdenSmallFont 10 400 "Segoe UI"
    !insertmacro VoxdenCreateFont $VoxdenWordmarkFont 21 600 "Segoe UI Semibold"
    !insertmacro VoxdenCreateFont $VoxdenTaglineFont 11 400 "Segoe UI"
    !insertmacro VoxdenCreateFont $VoxdenTitleFont 14 700 "Segoe UI"
  ${EndIf}

  ${NSD_CreateLabel} 5u 11u 99u 12u "FOR WINDOWS"
  Pop $0
  !insertmacro VoxdenSidebarLabel "A9C5B7" $VoxdenSmallFont

  ${NSD_CreateLabel} 5u 96u 99u 24u "Voxden"
  Pop $0
  !insertmacro VoxdenSidebarLabel "F1F7F4" $VoxdenWordmarkFont

  ${NSD_CreateLabel} 5u 124u 99u 30u "Your voice.$\r$\nIn writing."
  Pop $0
  !insertmacro VoxdenSidebarLabel "C3D8CD" $VoxdenTaglineFont

  ${NSD_CreateLabel} 5u 172u 99u 12u "Private by design"
  Pop $0
  !insertmacro VoxdenSidebarLabel "A9C5B7" $VoxdenSmallFont
!macroend

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW VoxdenWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "Your voice, ready anywhere"
  !define MUI_WELCOMEPAGE_TEXT "Set up Voxden, a private dictation workspace built for Windows.$\r$\n$\r$\nPress Ctrl+Shift+Space in any app to speak. Your words are transcribed locally and pasted where you were working.$\r$\n$\r$\nNo account. No telemetry. No API key."
  !insertmacro MUI_PAGE_WELCOME

  Function VoxdenWelcomeShow
    !insertmacro VoxdenSidebarText
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $VoxdenTitleFont 1
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $VoxdenSmallFont 1
  FunctionEnd
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "Voxden is ready"
  !define MUI_FINISHPAGE_TEXT "Press Ctrl+Shift+Space to dictate in any app.$\r$\n$\r$\nChoose your microphone and speech engine in Settings."
  !define MUI_FINISHPAGE_TEXT_LARGE

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW VoxdenFinishShow

  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Voxden"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH

  ; Keep the credit below the launch option, including on the reboot page.
  Function VoxdenFinishShow
    !insertmacro VoxdenSidebarText
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $VoxdenTitleFont 1
    SendMessage $mui.FinishPage.Text ${WM_SETFONT} $VoxdenSmallFont 1
    SendMessage $mui.FinishPage.Run ${WM_SETFONT} $VoxdenSmallFont 1
    ${NSD_CreateLabel} 120u 158u 195u 12u "Made by Sounak"
    Pop $0
    SetCtlColors $0 "5E726A" "${MUI_BGCOLOR}"
    SendMessage $0 ${WM_SETFONT} $VoxdenSmallFont 1
  FunctionEnd
!macroend

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VoxdenWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "Remove Voxden"
  !define MUI_WELCOMEPAGE_TEXT "This will remove the Voxden app from your computer.$\r$\n$\r$\nYour dictation history and local preferences are kept on this PC. You can remove them separately from Voxden's data folder."
  !insertmacro MUI_UNPAGE_WELCOME

  Function un.VoxdenWelcomeShow
    !insertmacro VoxdenSidebarText
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $VoxdenTitleFont 1
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $VoxdenSmallFont 1
  FunctionEnd
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VoxdenFinishShow
  !insertmacro MUI_UNPAGE_FINISH

  Function un.VoxdenFinishShow
    !insertmacro VoxdenSidebarText
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $VoxdenTitleFont 1
    SendMessage $mui.FinishPage.Text ${WM_SETFONT} $VoxdenSmallFont 1
  FunctionEnd
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
