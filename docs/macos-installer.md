# The macOS curl installer

## Install

```sh
curl -fsSL https://github.com/mrdanpsmith/edi/releases/latest/download/install.sh | bash
```

Pin a version:

```sh
curl -fsSL https://github.com/mrdanpsmith/edi/releases/latest/download/install.sh \
  | EDI_VERSION=X.Y.Z bash
```

Add `EDI_FORCE=1` to reinstall the version already installed.

The installer downloads the arm64 zip and its `.sha256` over HTTPS, verifies
both and the code signature, quits a running Edi, swaps the bundle with
rollback, clears any quarantine xattr, and re-registers the bundle with Launch
Services. The app is installed into `/Applications` when writable, otherwise
`~/Applications`.

If the requested version is already installed and `EDI_FORCE` is unset, the
installer exits before the association step, so no prompt appears. Use
`EDI_FORCE=1` to run the full install and the prompt again.

This is the no-quarantine path: curl does not add the quarantine flag, so it
avoids the Gatekeeper "Open Anyway" prompt a browser download gets. A
browser-downloaded `.dmg` is ad-hoc signed but not notarized, so its first open
warns; right-click → Open, or run:

```sh
xattr -dr com.apple.quarantine Edi.app
```

## File association

The bundle declares the Markdown UTI (`net.daringfireball.markdown`) and the
plain-text type in its Info.plist. Registering the bundle imports those types,
and on a Mac where nothing else owns Markdown that can make Edi the `.md`
handler. The installer therefore asks before changing the association and never
assumes.

### Prompt behaviour

The installer reads the current handler before swapping the bundle, so the
reading is pre-Edi.

When Edi is **not** the current Markdown handler:

```text
Make Edi the default app for Markdown files? [y/N]
```

The default is no.

When Edi **is** already the default:

```text
Keep Edi as the default app for Markdown files? [Y/n]
```

The default is yes. Enter therefore never silently un-associates Edi, but a
`n` still lets the user opt out.

The prompt reads and writes `/dev/tty`, so it works through
`curl … | bash` while stdin remains the script. A non-interactive run has no
controlling terminal and keeps the current association.

`EDI_SET_DEFAULT=1` answers yes without the prompt; `EDI_SET_DEFAULT=0`
answers no. Any other value is rejected.

Declining restores the previous handler. If there was no previous Markdown
handler, or the previous handler was Edi, it restores the plain-text handler
(TextEdit on a stock Mac), which is what `.md` files opened with before Edi
arrived.

The installer reads and writes the handler through the `osascript` JXA bridge:

```text
LSCopyDefaultRoleHandlerForContentType
LSSetDefaultRoleHandlerForContentType
```

This is the same Launch Services API Finder uses, not `lsregister` dump
parsing. The JXA script is passed on stdin to `osascript -l JavaScript -`, and
the UTI is passed as `argv[0]` to the script's `run` handler. `kLSRolesAll`
selects the default role. A returned `-` sentinel means "no handler"; empty
output means the query failed.

### Manual override

Finder can also make Edi the default: Get Info on a `.md` file → **Open with:
Edi → Change All…**. The choice is stored against the bundle ID, so it survives
upgrades.

## Open-document events

Finder does not pass a double-clicked file as `argv`. It sends
`kAEOpenDocuments`, which Qt turns into a `QFileOpenEvent`.

`backend/main.py`'s `_EdiApplication` catches the event and:

- queues paths until the window exists on a cold launch;
- forwards them to `MainWindow.open_files` on a warm launch.

The bridge queues paths until the page's first `getPendingFiles` call marks it
ready, then pushes:

```json
{"type": "openFiles", "paths": ["…"]}
```

over `notify`. `src/fileController.ts` opens them as tabs in the existing window.

## Release plumbing

The root `install.sh` is published as a release asset by the `release` job:

```sh
cp install.sh artifacts/install.sh
```

That is what makes `releases/latest/download/install.sh` work. A change to the
installer in the working tree is not visible at that URL until a release is
published.

## Verification notes

The JXA path cannot be exercised on Linux. The installer logic can be tested
with a stub `PlistBuddy`/`lsregister` and a pty, but the real Launch Services
calls and the prompt through `curl | bash` need a Mac. When touching the
installer, verify at least:

- the Make prompt (yes and no) on a Mac with another Markdown handler;
- the Keep prompt (Enter and `n`) when Edi is already default;
- non-interactive behaviour;
- `EDI_SET_DEFAULT=1` and `0`;
- that a declined association restores the previous or plain-text handler.
