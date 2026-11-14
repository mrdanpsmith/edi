; NSIS installer for Edi (Windows).
;
; Built by the CI build-windows job (native Windows makensis) and on a
; Windows desktop:
;   makensis /DVERSION=0.5.0 /DBUNDLE=dist-app\Edi \
;            /DICO=scripts\assets\app-icon.ico packaging\edi.nsi
; Define values are absolute paths when run from any directory.
;
; BUNDLE is the PyInstaller onedir bundle (Edi.exe + _internal\). It is
; installed as-is: Edi.exe finds _internal\ next to itself.

!ifndef VERSION
  !error "VERSION not defined (run with /DVERSION=0.5.0)"
!endif
!ifndef BUNDLE
  !error "BUNDLE not defined (run with /DBUNDLE=dist-app\Edi)"
!endif
!ifndef ICO
  !define ICO "app-icon.ico"
!endif
!ifndef OUTEXE
  !define OUTEXE "dist-app\Edi-${VERSION}-win64-setup.exe"
!endif

Name "Edi ${VERSION}"
OutFile "${OUTEXE}"
InstallDir "$PROGRAMFILES64\Edi"
RequestExecutionLevel admin
Unicode true

VIProductVersion "${VERSION}.0"
VIFileVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Edi"
VIAddVersionKey "FileDescription" "Edi Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "GPL-3.0-or-later"

!include "MUI2.nsh"
!include "LogicLib.nsh"

; --- File associations --------------------------------------------------------
; Windows 10+ will not let an installer make itself the default handler (the
; per-user UserChoice is hash-protected), so Edi only *offers* itself: it shows
; in Explorer's "Open with" (OpenWithProgids) and in Settings > Default apps
; (Capabilities + RegisteredApplications), and the user picks it from there.
; The one exception is a Mermaid extension no other app has claimed: Edi takes
; it, like the macOS bundle's Default rank, and gives it back on uninstall.
;
; These live in the 64-bit registry view (the installer itself is 32-bit), so
; Default apps finds them; the Uninstall key above keeps its existing view.

!define EDI_CAPS "Software\Edi\Capabilities"
!define EDI_APP "Software\Classes\Applications\Edi.exe"
!define SHCNE_ASSOCCHANGED 0x08000000

!macro EdiProgId PROGID DESCRIPTION
  WriteRegStr HKLM "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr HKLM "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\Edi.exe,0"
  WriteRegStr HKLM "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\Edi.exe" "%1"'
!macroend

!macro EdiOffer EXT PROGID
  WriteRegStr HKLM "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKLM "${EDI_APP}\SupportedTypes" "${EXT}" ""
  WriteRegStr HKLM "${EDI_CAPS}\FileAssociations" "${EXT}" "${PROGID}"
!macroend

!macro EdiClaimIfUnowned EXT PROGID
  ReadRegStr $0 HKLM "Software\Classes\${EXT}" ""
  ${If} $0 == ""
    WriteRegStr HKLM "Software\Classes\${EXT}" "" "${PROGID}"
  ${EndIf}
!macroend

!macro EdiUnoffer EXT PROGID
  DeleteRegValue HKLM "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty HKLM "Software\Classes\${EXT}\OpenWithProgids"
  ReadRegStr $0 HKLM "Software\Classes\${EXT}" ""
  ${If} $0 == "${PROGID}"
    DeleteRegValue HKLM "Software\Classes\${EXT}" ""
  ${EndIf}
  DeleteRegKey /ifempty HKLM "Software\Classes\${EXT}"
!macroend

!define MUI_ICON "${ICO}"
!define MUI_UNICON "${ICO}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Edi"
  SetOutPath "$INSTDIR"
  ; An upgrade must not leave the previous version's libraries beside the new
  ; ones; _internal\ only ever holds the bundle.
  RMDir /r "$INSTDIR\_internal"
  File "${BUNDLE}\Edi.exe"
  File /r "${BUNDLE}\_internal"
  File "${ICO}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Edi"
  CreateShortcut "$SMPROGRAMS\Edi\Edi.lnk" "$INSTDIR\Edi.exe" "" "$INSTDIR\app-icon.ico"
  CreateShortcut "$DESKTOP\Edi.lnk" "$INSTDIR\Edi.exe" "" "$INSTDIR\app-icon.ico"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi" \
    "DisplayName" "Edi ${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi" \
    "DisplayIcon" "$INSTDIR\Edi.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi" \
    "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi" \
    "Publisher" "Edi"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi" \
    "InstallLocation" "$INSTDIR"

  SetRegView 64
  !insertmacro EdiProgId "Edi.Markdown" "Markdown Document"
  !insertmacro EdiProgId "Edi.Mermaid" "Mermaid Diagram"

  WriteRegStr HKLM "${EDI_APP}" "FriendlyAppName" "Edi"
  WriteRegStr HKLM "${EDI_APP}\shell\open\command" "" '"$INSTDIR\Edi.exe" "%1"'

  WriteRegStr HKLM "${EDI_CAPS}" "ApplicationName" "Edi"
  WriteRegStr HKLM "${EDI_CAPS}" "ApplicationDescription" \
    "Markdown editor with live preview, code, Mermaid diagrams, and spreadsheets"
  WriteRegStr HKLM "${EDI_CAPS}" "ApplicationIcon" "$INSTDIR\Edi.exe,0"
  WriteRegStr HKLM "Software\RegisteredApplications" "Edi" "${EDI_CAPS}"

  !insertmacro EdiOffer ".md" "Edi.Markdown"
  !insertmacro EdiOffer ".markdown" "Edi.Markdown"
  !insertmacro EdiOffer ".mmd" "Edi.Mermaid"
  !insertmacro EdiOffer ".mermaid" "Edi.Mermaid"
  !insertmacro EdiClaimIfUnowned ".mmd" "Edi.Mermaid"
  !insertmacro EdiClaimIfUnowned ".mermaid" "Edi.Mermaid"
  SetRegView default

  System::Call 'shell32::SHChangeNotify(i ${SHCNE_ASSOCCHANGED}, i 0, i 0, i 0)'
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\Edi.exe"
  RMDir /r "$INSTDIR\_internal"
  Delete "$INSTDIR\app-icon.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Edi\Edi.lnk"
  RMDir "$SMPROGRAMS\Edi"
  Delete "$DESKTOP\Edi.lnk"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Edi"

  SetRegView 64
  !insertmacro EdiUnoffer ".md" "Edi.Markdown"
  !insertmacro EdiUnoffer ".markdown" "Edi.Markdown"
  !insertmacro EdiUnoffer ".mmd" "Edi.Mermaid"
  !insertmacro EdiUnoffer ".mermaid" "Edi.Mermaid"
  DeleteRegValue HKLM "Software\RegisteredApplications" "Edi"
  DeleteRegKey HKLM "Software\Edi"
  DeleteRegKey HKLM "${EDI_APP}"
  DeleteRegKey HKLM "Software\Classes\Edi.Markdown"
  DeleteRegKey HKLM "Software\Classes\Edi.Mermaid"
  SetRegView default

  System::Call 'shell32::SHChangeNotify(i ${SHCNE_ASSOCCHANGED}, i 0, i 0, i 0)'
SectionEnd