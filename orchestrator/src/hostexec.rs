//! Host execution engine — agents run as commands on THIS machine, each in
//! its own tmux session (`agent-<role>`), so the user can `tmux attach` and
//! watch the team work live. Replaces the old Docker-exec seam with the same
//! contract (run a shell command for an agent, return exit code + combined
//! output), but the "box" is the user's own Mac with their real $HOME, tools
//! and logins — one machine, one identity, per the per-machine auth rule.
//!
//! Execution shape (per command):
//!   1. ensure the agent's tmux session exists (created inside the shared
//!      workspace directory)
//!   2. write a self-contained bash script to <data>/tmp/cmd-<n>.sh (0600):
//!      env exports, then `( command ) </dev/null 2>&1 | tee out` so the pane
//!      shows the output LIVE while it also lands in a file byte-exact, then
//!      `printf PIPESTATUS > code`, then the script deletes itself
//!   3. `tmux new-window` runs the script (remain-on-exit keeps the pane and
//!      its scrollback around afterwards); we poll the code file — written
//!      only after tee's pipe closes, i.e. fully flushed — and read the
//!      output file for the captured text
//!   4. kill the finished window, return (exit code, output)
//!
//! Without tmux (or when no session is reachable), every exec falls back to a
//! headless `bash -c` process — everything above the seam works, just without
//! the live pane.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Shared working tree for the whole team — the host equivalent of the old
/// ai-agent-platform-workspace volume: one cloned repo + deliverables, like a
/// single box all the agents work on.
pub fn workspace_dir() -> PathBuf {
    match std::env::var("AAP_WORKSPACE") {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => PathBuf::from("./workspace"),
    }
}

pub fn workspace_str() -> String {
    workspace_dir().to_string_lossy().into_owned()
}

/// Session name for a persona role ("dev" → "agent-dev"). This is also the
/// identifier every API endpoint sees as the container id — same naming as
/// the old Docker containers, so paused.json/last_activity/run history that
/// key by this name migrate unchanged.
pub fn session_name(role: &str) -> String {
    format!("agent-{role}")
}

/// Role back out of a session name (unknown names come back as-is).
pub fn role_of(name: &str) -> &str {
    name.strip_prefix("agent-").unwrap_or(name)
}

// ---------------------------------------------------------------------------
// tmux plumbing
// ---------------------------------------------------------------------------

static TMUX_OK: AtomicBool = AtomicBool::new(false);
static TMUX_CHECKED: AtomicBool = AtomicBool::new(false);

/// tmux binary resolved once (`tmux -V` — list-sessions fails when no server
/// is running yet, so it is not a presence check). false = headless fallback.
pub fn tmux_available() -> bool {
    if !TMUX_CHECKED.swap(true, Ordering::SeqCst) {
        let ok = std::process::Command::new("tmux")
            .arg("-V")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        TMUX_OK.store(ok, Ordering::SeqCst);
        if !ok {
            eprintln!("warning: tmux not found — agent commands run headless (no live panes)");
        }
    }
    TMUX_OK.load(Ordering::SeqCst)
}

async fn tmux(args: &[&str]) -> Result<std::process::Output, String> {
    tokio::process::Command::new("tmux")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("tmux spawn failed: {e}"))
}

/// tmux target with the `=` exact-match prefix — plain `-t agent-dev` would
/// ALSO match `agent-dev-be` (prefix matching), pairing execs with the wrong
/// agent's session.
fn exact(name: &str) -> String {
    format!("={name}")
}

pub async fn session_alive(name: &str) -> bool {
    if !tmux_available() { return false; }
    tmux(&["has-session", "-t", &exact(name)])
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create the agent's session if missing (idempotent, race-tolerant). The
/// session starts in the shared workspace with a plain "main" window that no
/// orchestrator command ever runs in — all execs get their own window.
pub async fn ensure_session(name: &str) -> Result<(), String> {
    // No tmux on this machine → headless mode. There is no session to create;
    // every exec falls through to `run_headless`, so runs still work.
    if !tmux_available() {
        return Ok(());
    }
    if session_alive(name).await {
        return Ok(());
    }
    let ws = workspace_dir();
    std::fs::create_dir_all(&ws).map_err(|e| format!("workspace {} unusable: {e}", ws.display()))?;
    let out = tmux(&[
        "new-session", "-d", "-s", name, "-n", "main",
        "-x", "220", "-y", "50", "-c", &ws.to_string_lossy(),
    ]).await?;
    if !out.status.success() && !session_alive(name).await {
        return Err(format!("tmux new-session failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

pub async fn kill_session(name: &str) -> bool {
    tmux(&["kill-session", "-t", &exact(name)])
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// All live session names (empty when no tmux server is running).
pub async fn list_sessions() -> Vec<String> {
    let Ok(o) = tmux(&["list-sessions", "-F", "#{session_name}"]).await else {
        return Vec::new();
    };
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// None = tmux itself could not answer (transient error) — NOT proof that the
/// window died. Treating an error as death used to make callers report a
/// failed command and retry while the first process kept running.
async fn window_exists(session: &str, window_id: &str) -> Option<bool> {
    let o = tmux(&["list-windows", "-t", &exact(session), "-F", "#{window_id}"]).await.ok()?;
    Some(String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == window_id))
}

async fn kill_window(session: &str, window_id: &str) -> bool {
    tmux(&["kill-window", "-t", &format!("={session}:{window_id}")])
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// argv that, run in a PTY, attaches to an agent's session through a private
/// grouped session: `new-session -d -s <group> -t <agent>` groups with the
/// agent (windows are shared — nothing is duplicated), then attaches to the
/// group. Web terminals and the user's own `tmux attach` coexist, and killing
/// the group on disconnect never touches the agent's windows.
pub fn attach_argv(agent: &str, group: &str) -> Vec<String> {
    vec![
        "new-session".into(), "-d".into(), "-s".into(), group.into(), "-t".into(), exact(agent),
        ";".into(),
        "attach-session".into(), "-t".into(), exact(group),
    ]
}

/// Delete stale command files from a previous process — nothing in-flight can
/// survive an orchestrator restart, so everything under <data>/tmp is garbage.
pub fn sweep_tmp() {
    let tmp = crate::data_dir().join("tmp");
    let Ok(entries) = std::fs::read_dir(&tmp) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("cmd-") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ---------------------------------------------------------------------------
// exec — the seam everything above calls through
// ---------------------------------------------------------------------------

/// Single-quote a value for sh ('…' with ' escaped as '\'' — safe for every
/// byte including newlines).
pub(crate) fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn valid_env_key(k: &str) -> bool {
    !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

static CMD_SEQ: AtomicU64 = AtomicU64::new(1);

/// Run `command` as the agent, in the agent's tmux session (live pane) or
/// headless when there is no live session (tmux missing, agent paused/swept).
/// NEVER creates a session — callers that need the agent alive ensure it first
/// (create/start/ensure_running/agent_container); this keeps probes (connectors)
/// from resurrecting a paused agent, which would defeat the idle sweeper.
/// Env pairs ("K=V") ride the script file / process env — never a command
/// line — the same secret-safety rule the old exec ENV injection had. No
/// overall timeout, matching docker exec.
pub async fn run(agent: &str, command: &str, env: &[String]) -> Result<(i64, String), String> {
    run_with_timeout(agent, command, env, None).await
}

/// Same seam as `run`, but a timeout KILLS the tmux window (and the headless
/// child) before returning — a CLI harness that hits its cap must not keep
/// mutating the repo in the background after the step already failed.
pub async fn run_with_timeout(
    agent: &str, command: &str, env: &[String], timeout: Option<Duration>,
) -> Result<(i64, String), String> {
    let ws = workspace_dir();
    std::fs::create_dir_all(&ws).map_err(|e| format!("workspace {} unusable: {e}", ws.display()))?;

    if !tmux_available() || !session_alive(agent).await {
        return run_headless(&ws, command, env, timeout).await;
    }

    let tmp = crate::data_dir().join("tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| format!("tmp dir {} unusable: {e}", tmp.display()))?;
    let n = CMD_SEQ.fetch_add(1, Ordering::SeqCst);
    let stem = tmp.join(format!("cmd-{n}"));
    let cmd_file = stem.with_extension("sh");
    let out_file = stem.with_extension("out");
    let code_file = stem.with_extension("code");

    let mut script = String::from("#!/bin/bash\n");
    for kv in env {
        let Some((k, v)) = kv.split_once('=') else { continue };
        if valid_env_key(k) {
            script.push_str(&format!("export {k}={}\n", shq(v)));
        }
    }
    script.push_str(&format!("cd {}\n", shq(&ws.to_string_lossy())));
    script.push_str(&format!(
        "( {command} ) </dev/null 2>&1 | tee {}\nprintf '%s' \"${{PIPESTATUS[0]}}\" > {}\nrm -f -- \"$0\"\n",
        shq(&out_file.to_string_lossy()),
        shq(&code_file.to_string_lossy()),
    ));
    std::fs::write(&cmd_file, script).map_err(|e| format!("writing {} failed: {e}", cmd_file.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&cmd_file, std::fs::Permissions::from_mode(0o600));
    }

    // Windows in this session keep their pane (and scrollback) after the
    // script exits — a watching user can still read what ran until we kill
    // the window once the output is collected.
    let _ = tmux(&["set-option", "-t", &exact(agent), "remain-on-exit", "on"]).await;
    let window_id = tmux(&[
        "new-window", "-P", "-t", &exact(agent), "-n", &format!("w{n}"),
        "-c", &ws.to_string_lossy(), "-F", "#{window_id}",
        &format!("bash {}", shq(&cmd_file.to_string_lossy())),
    ]).await?;
    if !window_id.status.success() {
        let _ = std::fs::remove_file(&cmd_file);
        return Err(format!(
            "tmux new-window failed: {}",
            String::from_utf8_lossy(&window_id.stderr).trim(),
        ));
    }
    let window_id = String::from_utf8_lossy(&window_id.stdout).trim().to_string();

    let deadline = timeout.map(|d| Instant::now() + d);
    let mut tmux_errors = 0u32;
    loop {
        if let Ok(code) = std::fs::read_to_string(&code_file) {
            // written only after tee's pipe closed — output is fully flushed
            let output = std::fs::read_to_string(&out_file).unwrap_or_default();
            let _ = kill_window(agent, &window_id).await;
            let _ = std::fs::remove_file(&out_file);
            let _ = std::fs::remove_file(&code_file);
            let code = code.trim().parse::<i64>().unwrap_or(-1);
            return Ok((code, output));
        }
        if let Some(dl) = deadline {
            if Instant::now() >= dl {
                let output = std::fs::read_to_string(&out_file).unwrap_or_default();
                let _ = kill_window(agent, &window_id).await;
                let _ = std::fs::remove_file(&out_file);
                let _ = std::fs::remove_file(&code_file);
                let tail = output.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
                let secs = timeout.map(|d| d.as_secs()).unwrap_or(0);
                return Err(if tail.trim().is_empty() {
                    format!("command timed out after {secs}s")
                } else {
                    format!("command timed out after {secs}s; last output:\n{tail}")
                });
            }
        }
        match window_exists(agent, &window_id).await {
            Some(true) => tmux_errors = 0,
            // the pane died without finishing — the user killed the session,
            // or the tmux server went down. Report what streamed so far.
            Some(false) => {
                let output = std::fs::read_to_string(&out_file).unwrap_or_default();
                let _ = std::fs::remove_file(&out_file);
                let _ = std::fs::remove_file(&code_file);
                return Ok((-1, format!("{output}\n(the agent's tmux window closed before the command finished)")));
            }
            // tmux could not answer — do not mistake a transient error for
            // death (the command would keep running unseen). Give it 15s.
            None => {
                tmux_errors += 1;
                if tmux_errors > 100 {
                    let _ = kill_window(agent, &window_id).await;
                    let _ = std::fs::remove_file(&out_file);
                    let _ = std::fs::remove_file(&code_file);
                    return Err("tmux stopped responding while the command was running".into());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn run_headless(
    ws: &std::path::Path, command: &str, env: &[String], timeout: Option<Duration>,
) -> Result<(i64, String), String> {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c").arg(command).current_dir(ws).kill_on_drop(true);
    for kv in env {
        if let Some((k, v)) = kv.split_once('=') {
            if valid_env_key(k) {
                cmd.env(k, v);
            }
        }
    }
    let out = match timeout {
        Some(d) => match tokio::time::timeout(d, cmd.output()).await {
            Ok(r) => r.map_err(|e| format!("bash spawn failed: {e}"))?,
            Err(_) => return Err(format!("command timed out after {}s", d.as_secs())),
        },
        None => cmd.output().await.map_err(|e| format!("bash spawn failed: {e}"))?,
    };
    let mut text = out.stdout;
    text.extend_from_slice(&out.stderr);
    Ok((out.status.code().map(i64::from).unwrap_or(-1), String::from_utf8_lossy(&text).into_owned()))
}
