use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Manager;

pub const SUPPORTED_EXTENSIONS: [&str; 4] = ["md", "markdown", "txt", "mermaid"];

const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

// Set when the frontend rejects a quit (e.g. the user cancelled an
// "unsaved changes" dialog), telling the close watchdog to stand down.
static QUIT_CANCELLED: AtomicBool = AtomicBool::new(false);

// How long the frontend may take to confirm/cancel a quit before the
// close watchdog forces the app to exit anyway.
const QUIT_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn parse_shebang(line: &str) -> Option<Vec<String>> {
    let rest = line.trim().strip_prefix("#!")?.trim();
    if rest.is_empty() {
        return None;
    }
    let mut tokens: Vec<String> = rest.split_whitespace().map(str::to_string).collect();
    if tokens[0].eq_ignore_ascii_case("env") || basename(&tokens[0]).eq_ignore_ascii_case("env") {
        let interpreter_at = tokens[1..]
            .iter()
            .position(|token| !token.starts_with('-'))
            .map(|index| index + 1)?;
        return Some(tokens.split_off(interpreter_at));
    }
    tokens[0] = basename(&tokens[0]);
    Some(tokens)
}

fn interpreter_command(interpreter: &str, flags: &[String]) -> Option<(String, Vec<String>)> {
    let (program, stdin_arg) = match interpreter.to_ascii_lowercase().as_str() {
        "python" | "python3" | "py" => ("python3", "-"),
        "sh" | "shell" => ("sh", "-s"),
        "bash" => ("bash", "-s"),
        "node" | "js" | "javascript" => ("node", "-"),
        "ruby" | "rb" => ("ruby", "-"),
        "perl" | "pl" => ("perl", "-"),
        _ => return None,
    };
    let mut args = flags.to_vec();
    args.push(stdin_arg.to_string());
    Some((program.to_string(), args))
}

fn strip_shebang_line(source: &str) -> String {
    match source.find('\n') {
        Some(end) if source[..end].trim_end_matches('\r').starts_with("#!") => {
            source[end + 1..].to_string()
        }
        None if source.trim_end_matches('\r').starts_with("#!") => String::new(),
        _ => source.to_string(),
    }
}

#[tauri::command]
async fn run_code_block(shebang: String, source: String) -> Result<CodeResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_code_block_blocking(shebang, source))
        .await
        .map_err(|err| format!("Code block task failed: {err}"))?
}

fn run_code_block_blocking(shebang: String, source: String) -> Result<CodeResult, String> {
    let parts = parse_shebang(&shebang).ok_or_else(|| format!("Invalid shebang: {shebang}"))?;
    let (interpreter, flags) = parts
        .split_first()
        .ok_or_else(|| format!("Invalid shebang: {shebang}"))?;
    let (program, args) = interpreter_command(interpreter, flags)
        .ok_or_else(|| format!("Unsupported interpreter: {interpreter}"))?;

    let mut command = std::process::Command::new(&program);
    command
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if program == "python3" {
        // Portable AppImages bundle a Python runtime and export PYTHONHOME /
        // PYTHONPATH pointing into the mount directory, which breaks the
        // system interpreter Edi launches. Drop them for Python so the code
        // block runs against a usable interpreter.
        command.env_remove("PYTHONHOME").env_remove("PYTHONPATH");
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {program}: {err}"))?;

    let run_source = strip_shebang_line(&source);
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(run_source.as_bytes())
            .map_err(|err| format!("Failed to write to {program}: {err}"))?;
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(EXEC_TIMEOUT) {
        Ok(Ok(output)) => Ok(CodeResult {
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            timed_out: false,
        }),
        Ok(Err(err)) => Err(format!("Failed to run {program}: {err}")),
        Err(_) => {
            let _ = std::process::Command::new("kill")
                .arg(pid.to_string())
                .status();
            Err(format!(
                "Execution timed out after {} seconds",
                EXEC_TIMEOUT.as_secs()
            ))
        }
    }
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let path = Path::new(&path);

    if !path.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if !is_supported_extension(path) {
        return Err(format!(
            "Unsupported file extension (expected one of {}): {}",
            SUPPORTED_EXTENSIONS.join(", "),
            path.display()
        ));
    }

    std::fs::read_to_string(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = Path::new(&path);

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create directory {}: {err}", parent.display()))?;
        }
    }

    std::fs::write(path, content)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))
}

fn is_supported_extension(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase);

    matches!(
        ext.as_deref(),
        Some("md") | Some("markdown") | Some("txt") | Some("mermaid")
    )
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    // On Linux, destroying the last window does not reliably end the GTK
    // event loop (the WebKit webview keeps it alive), so the app stays up and
    // users end up killing it with Ctrl+C. Exit explicitly instead.
    app.exit(0);
}

#[tauri::command]
fn cancel_quit() {
    QUIT_CANCELLED.store(true, Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            run_code_block,
            quit_app,
            cancel_quit
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Safety net: the frontend is asked to confirm the quit. If it
                // never replies (hung dialog, lost event, broken webview) the
                // watchdog force-quits instead of trapping the user.
                QUIT_CANCELLED.store(false, Ordering::Relaxed);
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + QUIT_WATCHDOG_TIMEOUT;
                    while std::time::Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(250));
                        if QUIT_CANCELLED.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join("edi-test")
            .join(format!("{label}-{}-{n}", std::process::id()))
    }

    #[test]
    fn supports_known_extensions() {
        for ext in SUPPORTED_EXTENSIONS {
            let name = format!("notes.{ext}");
            assert!(
                is_supported_extension(Path::new(&name)),
                "{ext} should be supported"
            );
        }
    }

    #[test]
    fn rejects_unknown_extensions() {
        assert!(!is_supported_extension(Path::new("notes.pdf")));
        assert!(!is_supported_extension(Path::new("notes")));
        assert!(!is_supported_extension(Path::new(".gitignore")));
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        assert!(is_supported_extension(Path::new("notes.MD")));
        assert!(is_supported_extension(Path::new("notes.Markdown")));
    }

    #[test]
    fn write_and_read_round_trip() {
        let dir = unique_temp_dir("roundtrip");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("roundtrip.md");

        write_text_file(file.display().to_string(), "# Hello\n".to_string())
            .expect("write should succeed");

        let content = read_text_file(file.display().to_string()).expect("read should succeed");
        assert_eq!(content, "# Hello\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_missing_file_errors() {
        let result = read_text_file("/nonexistent/path.md".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn write_creates_parent_directories() {
        let dir = unique_temp_dir("nested");
        let file = dir.join("nested").join("notes.md");

        write_text_file(file.display().to_string(), "content".to_string())
            .expect("write should create parent directories");

        assert!(file.is_file());
        let content = read_text_file(file.display().to_string()).expect("read should succeed");
        assert_eq!(content, "content");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parses_shebang_forms() {
        assert_eq!(
            parse_shebang("#!/usr/bin/env python3"),
            Some(vec!["python3".to_string()])
        );
        assert_eq!(
            parse_shebang("#!/usr/bin/env python3 -u"),
            Some(vec!["python3".to_string(), "-u".to_string()])
        );
        assert_eq!(
            parse_shebang("#!/bin/bash -e"),
            Some(vec!["bash".to_string(), "-e".to_string()])
        );
        assert_eq!(
            parse_shebang("#!/usr/bin/python3"),
            Some(vec!["python3".to_string()])
        );
        assert_eq!(parse_shebang("#!node"), Some(vec!["node".to_string()]));
        assert_eq!(
            parse_shebang("#!env node --harmony"),
            Some(vec!["node".to_string(), "--harmony".to_string()])
        );
        assert_eq!(parse_shebang("#!"), None);
        assert_eq!(parse_shebang("python"), None);
    }

    #[test]
    fn maps_interpreters_to_commands() {
        assert_eq!(
            interpreter_command("python", &[]),
            Some(("python3".to_string(), vec!["-".to_string()]))
        );
        assert_eq!(
            interpreter_command("bash", &["-e".to_string()]),
            Some(("bash".to_string(), vec!["-e".to_string(), "-s".to_string()]))
        );
        assert_eq!(
            interpreter_command("SH", &[]),
            Some(("sh".to_string(), vec!["-s".to_string()]))
        );
        assert!(interpreter_command("brainfuck", &[]).is_none());
    }

    #[test]
    fn strips_leading_shebang_line() {
        assert_eq!(
            strip_shebang_line("#!/usr/bin/env python3\nprint(1)"),
            "print(1)"
        );
        assert_eq!(
            strip_shebang_line("#!/usr/bin/env python3\n\nprint(1)"),
            "\nprint(1)"
        );
        assert_eq!(strip_shebang_line("#!/usr/bin/env python3"), "");
        assert_eq!(strip_shebang_line("print(1)"), "print(1)");
        assert_eq!(strip_shebang_line("#!/bin/sh\r\necho hi"), "echo hi");
    }

    #[test]
    fn runs_shell_code_block() {
        let result = run_code_block_blocking("#!sh".to_string(), "echo hello from edi".to_string())
            .expect("run ok");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), "hello from edi");
        assert!(result.stderr.is_empty());
        assert!(!result.timed_out);
    }

    #[test]
    fn runs_env_shebang_block() {
        let result = run_code_block_blocking(
            "#!/usr/bin/env python3".to_string(),
            "#!/usr/bin/env python3\nprint(21 * 2)".to_string(),
        )
        .expect("run ok");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), "42");
        assert!(result.stderr.is_empty());
        assert!(!result.timed_out);
    }

    #[test]
    fn ignores_appimage_python_environment() {
        std::env::set_var("PYTHONHOME", "/tmp/.mount_Edi_0.FhNjoL/usr");
        std::env::set_var("PYTHONPATH", "/tmp/.mount_Edi_0.FhNjoL/usr/share/pyshared/");

        let result = run_code_block_blocking(
            "#!/usr/bin/env python3".to_string(),
            "import sys\nprint(sys.base_prefix)".to_string(),
        )
        .expect("run ok");

        std::env::remove_var("PYTHONHOME");
        std::env::remove_var("PYTHONPATH");

        assert_eq!(result.exit_code, Some(0));
        assert!(
            !result.stdout.contains("mount_Edi"),
            "python must ignore the AppImage's PYTHONHOME, got: {}",
            result.stdout
        );
        assert!(!result.timed_out);
    }

    #[test]
    fn passes_source_via_stdin() {
        let result = run_code_block_blocking(
            "#!node".to_string(),
            "console.log('hi from node')".to_string(),
        )
        .expect("run ok");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), "hi from node");
    }

    #[test]
    fn captures_stderr_and_exit_code() {
        let result = run_code_block_blocking(
            "#!/bin/sh".to_string(),
            "echo oops >&2; exit 3\n".to_string(),
        )
        .expect("run ok");
        assert_eq!(result.exit_code, Some(3));
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("oops"));
    }

    #[test]
    fn rejects_invalid_and_unknown_shebangs() {
        let result = run_code_block_blocking("#!brainfuck".to_string(), "+++".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported interpreter"));

        let result = run_code_block_blocking("#!".to_string(), "+++".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid shebang"));
    }
}
