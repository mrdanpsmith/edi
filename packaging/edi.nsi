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
SectionEnd