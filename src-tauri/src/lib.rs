use std::io::Write;
use std::path::Path;
use std::time::Duration;

pub const SUPPORTED_EXTENSIONS: [&str; 4] = ["md", "markdown", "txt", "mermaid"];

const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn command_for(language: &str) -> Option<(&'static str, &'static [&'static str])> {
    match language.to_ascii_lowercase().as_str() {
        "python" | "py" => Some(("python3", &["-"])),
        "sh" | "shell" => Some(("sh", &["-s"])),
        "bash" => Some(("bash", &["-s"])),
        "node" | "js" | "javascript" => Some(("node", &["-"])),
        "ruby" | "rb" => Some(("ruby", &["-"])),
        "perl" | "pl" => Some(("perl", &["-"])),
        _ => None,
    }
}

#[tauri::command]
fn run_code_block(language: String, source: String) -> Result<CodeResult, String> {
    let (program, args) =
        command_for(&language).ok_or_else(|| format!("Unsupported language: {language}"))?;

    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("Failed to start {program}: {err}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(source.as_bytes())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            run_code_block
        ])
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
    fn maps_supported_languages() {
        assert_eq!(command_for("python"), Some(("python3", &["-"] as &[&str])));
        assert_eq!(command_for("sh"), Some(("sh", &["-s"] as &[&str])));
        assert_eq!(command_for("bash"), Some(("bash", &["-s"] as &[&str])));
        assert_eq!(command_for("node"), Some(("node", &["-"] as &[&str])));
        assert_eq!(command_for("PYTHON"), Some(("python3", &["-"] as &[&str])));
        assert!(command_for("brainfuck").is_none());
    }

    #[test]
    fn runs_shell_code_block() {
        let result =
            run_code_block("sh".to_string(), "echo hello from edi".to_string()).expect("run ok");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), "hello from edi");
        assert!(result.stderr.is_empty());
        assert!(!result.timed_out);
    }

    #[test]
    fn passes_source_via_stdin() {
        let result = run_code_block(
            "node".to_string(),
            "console.log('hi from node')".to_string(),
        )
        .expect("run ok");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), "hi from node");
    }

    #[test]
    fn captures_stderr_and_exit_code() {
        let result = run_code_block("sh".to_string(), "echo oops >&2; exit 3\n".to_string())
            .expect("run ok");
        assert_eq!(result.exit_code, Some(3));
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("oops"));
    }

    #[test]
    fn rejects_unknown_languages() {
        let result = run_code_block("brainfuck".to_string(), "+++".to_string());
        assert!(result.is_err());
    }
}
