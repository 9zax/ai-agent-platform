use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions,
};
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::query_parameters::{
    InspectContainerOptions, ListContainersOptionsBuilder, RemoveContainerOptionsBuilder,
    RestartContainerOptions, StartContainerOptions, StatsOptionsBuilder, StopContainerOptions,
};
use bollard::Docker;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SERVICE_NAME: &str = "AI Agent Platform Orchestrator";
const MANAGED_LABEL: &str = "managed-by";
const MANAGED_VALUE: &str = "ai-agent-platform";
const AGENT_NETWORK: &str = "ai-agent-platform_agent-net";

// ---------------------------------------------------------------------------
// Provider templates — one click in the UI fills these in
// ---------------------------------------------------------------------------

struct ProviderTemplate {
    id: &'static str,
    label: &'static str,
    protocol: &'static str, // "anthropic" | "openai"
    base_url: &'static str,
    model: &'static str,
    key_hint: &'static str,
    local: bool,
    note: &'static str,
}

const PROVIDERS: &[ProviderTemplate] = &[
    ProviderTemplate { id: "zai", label: "Z.ai GLM", protocol: "anthropic", base_url: "https://api.z.ai/api/anthropic", model: "glm-4.5-air", key_hint: "Z.ai API key (from z.ai)", local: false, note: "ค่าเริ่มต้นของ platform — โมเดล GLM ผ่าน Anthropic-compatible endpoint" },
    ProviderTemplate { id: "anthropic", label: "Anthropic", protocol: "anthropic", base_url: "https://api.anthropic.com", model: "claude-sonnet-4-5", key_hint: "sk-ant-...", local: false, note: "Claude models" },
    ProviderTemplate { id: "openai", label: "OpenAI", protocol: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o", key_hint: "sk-...", local: false, note: "GPT models" },
    ProviderTemplate { id: "openrouter", label: "OpenRouter", protocol: "openai", base_url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", key_hint: "sk-or-...", local: false, note: "หลายโมเดลในที่เดียว" },
    ProviderTemplate { id: "groq", label: "Groq", protocol: "openai", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key_hint: "gsk_...", local: false, note: "เร็วมาก" },
    ProviderTemplate { id: "deepseek", label: "DeepSeek", protocol: "openai", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", key_hint: "sk-...", local: false, note: "คุ้มสำหรับงาน code" },
    ProviderTemplate { id: "ollama", label: "Ollama (local)", protocol: "openai", base_url: "http://host.docker.internal:11434/v1", model: "llama3.2", key_hint: "ไม่ต้องมี key", local: true, note: "รันบนเครื่องตัวเอง ไม่มีค่าใช้จ่าย" },
    ProviderTemplate { id: "custom", label: "Custom", protocol: "openai", base_url: "", model: "", key_hint: "ใส่ base URL เอง", local: false, note: "OpenAI-compatible อื่น ๆ" },
];

fn provider_template(id: &str) -> Option<&'static ProviderTemplate> {
    PROVIDERS.iter().find(|p| p.id == id)
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct Persona {
    role: String,
    name: String,
    title: String,
    years: String,
    expertise: String,
    /// Persona rules / system prompt, edited as markdown in the UI
    #[serde(rename = "rules_md", default)]
    rules_md: String,
}

fn seed_personas() -> Vec<Persona> {
    let mk = |role: &str, name: &str, title: &str, years: &str, expertise: &str, rules: &str| Persona {
        role: role.into(), name: name.into(), title: title.into(), years: years.into(),
        expertise: expertise.into(), rules_md: rules.into(),
    };
    vec![
        mk("po", "Nara", "Product Owner", "16",
           "Product strategy, user stories, backlog grooming, roadmap, prioritization (RICE/MoSCoW), stakeholder alignment",
           "You are Nara, a Product Owner with 16 years of experience shipping B2B and B2C products. You write crisp, testable user stories with clear acceptance criteria, think in outcomes not features, and ruthlessly prioritize scope."),
        mk("research", "Kanta", "Research Engineer", "15",
           "Technical research, benchmarking, data collection, literature review, proof-of-concept prototyping",
           "You are Kanta, a Research Engineer with 15 years of experience. You validate assumptions with evidence, benchmark alternatives, cite concrete trade-offs, and prototype to de-risk decisions."),
        mk("dev-fe", "Firn", "Frontend Developer", "15",
           "React, Next.js, TypeScript, Tailwind, design systems, accessibility, web performance, Core Web Vitals",
           "You are Firn, a Frontend Developer with 15 years of experience. You write clean, accessible, performant React; you know when to reach for a design system, how to keep bundles small, and you never ship layout that breaks on mobile."),
        mk("dev-be", "Boyd", "Backend Developer", "17",
           "Rust, Python, FastAPI, Node.js, PostgreSQL, Redis, API design, distributed systems, observability",
           "You are Boyd, a Backend Developer with 17 years of experience. You design APIs that age well, defend with tests and observability, and you know the difference between 'works' and 'works at 3am under load'.\n\n## External capabilities\n- `gh` CLI is installed: you can create/view GitHub issues and PRs (e.g. `gh issue create --title ... --body ...`) when the user asks\n- `git` is available for clones, commits and diffs"),
        mk("ux-ui", "Mali", "UX/UI Designer", "14",
           "User research, information architecture, interaction design, prototyping, Figma, design tokens, dark-mode systems",
           "You are Mali, a UX/UI Designer with 14 years of experience. You design with evidence from users, keep interfaces calm and consistent, obsess over states (empty/loading/error), and document decisions in tokens and components."),
        mk("qa", "Tara", "QA Engineer", "14",
           "Test strategy, E2E automation (Playwright), API testing, contract testing, CI quality gates, exploratory testing",
           "You are Tara, a QA Engineer with 14 years of experience. You think in risk, write tests that fail for the right reason, automate the boring 80%, and explore the dangerous 20% humans find."),
    ]
}

#[derive(Clone, Serialize)]
struct Task {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    status: String,
    category: String,
    priority: String,
    agent: String,
    due: String,
}

#[derive(Clone, Serialize)]
struct Skill {
    id: String,
    name: String,
    description: String,
    enabled: bool,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct ProjectLink {
    from: String,
    to: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Position {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Project {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    /// persona roles in this project's team
    #[serde(default)]
    agents: Vec<String>,
    /// who talks to whom (react flow edges)
    #[serde(default)]
    links: Vec<ProjectLink>,
    /// react flow node positions per role
    #[serde(default)]
    positions: HashMap<String, Position>,
}

#[derive(Deserialize)]
struct ProjectCreate {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProjectUpdate {
    #[serde(default)] name: Option<String>,
    #[serde(default)] description: Option<String>,
    #[serde(default)] agents: Option<Vec<String>>,
    #[serde(default)] links: Option<Vec<ProjectLink>>,
    #[serde(default)] positions: Option<HashMap<String, Position>>,
}

#[derive(Clone)]
struct AiConfig {
    default_model: String,
    default_image: String,
    max_containers: u32,
    auto_restart: bool,
    ai_provider: String,
    ai_base_url: String,
    ai_model: String,
    ai_api_key: String,
    /// sha256 hex of the admin password that gates console access to all containers ("" = no gate)
    admin_password_hash: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            default_model: "glm-4.5-air".into(),
            default_image: "alpine:latest".into(),
            max_containers: 10,
            auto_restart: true,
            ai_provider: "zai".into(),
            ai_base_url: String::new(),
            ai_model: String::new(),
            ai_api_key: String::new(),
            admin_password_hash: String::new(),
        }
    }
}

struct Store {
    personas: Vec<Persona>,
    tasks: Vec<Task>,
    skills: Vec<Skill>,
    projects: Vec<Project>,
    config: AiConfig,
    /// login sessions: token → username (web UI auth, ADMIN_USER/ADMIN_PASSWORD from env)
    sessions: HashMap<String, String>,
    task_counter: usize,
    project_counter: usize,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            personas: seed_personas(),
            tasks: Vec::new(),
            skills: vec![
                Skill { id: "web-research".into(), name: "Web Research".into(), description: "Search, crawl and summarize web sources".into(), enabled: true },
                Skill { id: "code-gen".into(), name: "Code Gen".into(), description: "Generate and refactor code from natural language".into(), enabled: true },
                Skill { id: "data-analysis".into(), name: "Data Analysis".into(), description: "Analyze datasets and produce reports and charts".into(), enabled: true },
                Skill { id: "file-ops".into(), name: "File Ops".into(), description: "Read, write and organize files in the workspace".into(), enabled: true },
                Skill { id: "api-testing".into(), name: "API Testing".into(), description: "Call APIs and validate responses against schemas".into(), enabled: true },
                Skill { id: "image-analysis".into(), name: "Image Analysis".into(), description: "Inspect and describe images".into(), enabled: false },
            ],
            projects: Vec::new(),
            config: AiConfig::default(),
            sessions: HashMap::new(),
            task_counter: 0,
            project_counter: 0,
        }
    }
}

#[derive(Clone)]
struct App {
    docker: Option<Docker>,
    store: Arc<Mutex<Store>>,
    seq: Arc<AtomicUsize>,
}

type ApiResult = Result<Response, ApiError>;

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "detail": self.1 }))).into_response()
    }
}

fn err(status: StatusCode, detail: impl Into<String>) -> ApiError {
    ApiError(status, detail.into())
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ContainerCreate {
    name: String,
    role: String,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    command: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CommandRequest {
    command: String,
    #[serde(default)]
    consult: bool,
}

#[derive(Deserialize, Default)]
struct AgentStartRequest {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PersonaUpdate {
    #[serde(default)] name: Option<String>,
    #[serde(default)] title: Option<String>,
    #[serde(default)] years: Option<String>,
    #[serde(default)] expertise: Option<String>,
    #[serde(default)] rules_md: Option<String>,
}

#[derive(Deserialize)]
struct TaskCreate {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_task_status")]
    status: String,
    #[serde(default = "default_category")]
    category: String,
    #[serde(default = "default_priority")]
    priority: String,
    #[serde(default = "default_agent")]
    agent: String,
    #[serde(default)]
    due: String,
    #[serde(default)]
    assign_to: Option<String>,
}

fn default_task_status() -> String { "todo".into() }
fn default_category() -> String { "General".into() }
fn default_priority() -> String { "medium".into() }
fn default_agent() -> String { "AD".into() }

#[derive(Deserialize, Default)]
#[serde(default)]
struct ConfigUpdate {
    default_model: Option<String>,
    default_image: Option<String>,
    max_containers: Option<u32>,
    auto_restart: Option<bool>,
    ai_provider: Option<String>,
    ai_base_url: Option<String>,
    ai_model: Option<String>,
    ai_api_key: Option<String>,
    admin_password: Option<String>,
}

#[derive(Deserialize)]
struct AuthVerify {
    password: String,
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Deserialize)]
struct SkillCreate {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct SkillUpdate {
    enabled: bool,
}

// ---------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------

impl App {
    fn docker(&self) -> Result<&Docker, ApiError> {
        self.docker.as_ref().ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "Docker not available"))
    }

    async fn inspect(&self, ident: &str) -> Result<bollard::models::ContainerInspectResponse, ApiError> {
        self.docker()?
            .inspect_container(ident, None::<InspectContainerOptions>)
            .await
            .map_err(|e| match e {
                bollard::errors::Error::DockerResponseServerError { status_code: 404, .. } =>
                    err(StatusCode::NOT_FOUND, format!("Container '{ident}' not found")),
                other => err(StatusCode::BAD_REQUEST, other.to_string()),
            })
    }

    async fn inspect_managed(&self, ident: &str) -> Result<bollard::models::ContainerInspectResponse, ApiError> {
        let c = self.inspect(ident).await?;
        let managed = c.config.as_ref()
            .and_then(|cfg| cfg.labels.as_ref())
            .and_then(|l| l.get(MANAGED_LABEL))
            .map(|v| v == MANAGED_VALUE)
            .unwrap_or(false);
        if !managed {
            let name = c.name.clone().unwrap_or_default().trim_start_matches('/').to_string();
            return Err(err(StatusCode::FORBIDDEN, format!("Container '{name}' is not managed by this platform")));
        }
        Ok(c)
    }

    fn status_of(c: &bollard::models::ContainerInspectResponse) -> String {
        c.state.as_ref().and_then(|s| s.status.as_ref()).map(|s| s.to_string()).unwrap_or_else(|| "unknown".into())
    }

    async fn exec_in(&self, container_id: &str, command: &str) -> Result<(i64, String), ApiError> {
        let exec = self.docker()?
            .create_exec(container_id, CreateExecOptions::<&str> {
                cmd: Some(vec!["sh", "-c", command]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            })
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;

        let mut bytes: Vec<u8> = Vec::new();
        let started = self.docker()?
            .start_exec(&exec.id, Some(StartExecOptions { detach: false, tty: false, ..Default::default() }))
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;
        if let StartExecResults::Attached { mut output, .. } = started {
            while let Some(Ok(frame)) = output.next().await {
                bytes.extend_from_slice(&frame.into_bytes());
            }
        }
        let exit_code = self.docker()?
            .inspect_exec(&exec.id)
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?
            .exit_code
            .unwrap_or(-1);
        Ok((exit_code, String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn effective_model(&self) -> String {
        let cfg = self.store.lock().unwrap().config.clone();
        let m = if cfg.ai_model.is_empty() { cfg.default_model.clone() } else { cfg.ai_model.clone() };
        if m.is_empty() { "glm-4.5-air".into() } else { m }
    }

    fn ai_credentials(&self) -> (String, String, &'static ProviderTemplate) {
        let env_key = std::env::var("ZAI_API_KEY").unwrap_or_default();
        let cfg = self.store.lock().unwrap().config.clone();
        let template = provider_template(&cfg.ai_provider).unwrap_or(&PROVIDERS[0]);
        let key = if cfg.ai_api_key.is_empty() { env_key } else { cfg.ai_api_key };
        let base = if cfg.ai_base_url.is_empty() { template.base_url.to_string() } else { cfg.ai_base_url.clone() };
        (key, base, template)
    }

    async fn llm(&self, system: &str, user_text: &str) -> Result<String, ApiError> {
        let (api_key, base, template) = self.ai_credentials();
        if api_key.is_empty() && !template.local {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "No API key configured — set one in AI Config"));
        }
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "No base URL configured for this provider — set one in AI Config"));
        }
        let model = self.effective_model();

        let client = reqwest::Client::new();
        let resp: reqwest::Response = if template.protocol == "anthropic" {
            client.post(format!("{base}/v1/messages"))
                .header("x-api-key", &api_key)
                .bearer_auth(&api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": model, "max_tokens": 400, "system": system,
                    "messages": [{ "role": "user", "content": user_text }],
                }))
                .send().await
        } else {
            let url = if base.contains("/v1") { format!("{base}/chat/completions") } else { format!("{base}/v1/chat/completions") };
            client.post(url)
                .bearer_auth(&api_key)
                .json(&json!({
                    "model": model, "max_tokens": 400,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user_text },
                    ],
                }))
                .send().await
        }
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("AI request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(err(StatusCode::BAD_GATEWAY, format!("AI request failed: {status} — {body}")));
        }
        let data: Value = resp.json().await
            .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("AI request failed: {e}")))?;

        let text = if template.protocol == "openai" {
            data.pointer("/choices/0/message/content").and_then(|v| v.as_str()).unwrap_or("").to_string()
        } else {
            data.get("content").and_then(|c| c.as_array()).map(|parts| {
                parts.iter()
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<String>()
            }).unwrap_or_default()
        };
        Ok(text.trim().to_string())
    }
}

// ---------------------------------------------------------------------------
// Handlers — root / health / providers
// ---------------------------------------------------------------------------

async fn root() -> Json<Value> {
    Json(json!({ "status": "ok", "service": SERVICE_NAME }))
}

fn json_ok(v: Value) -> Response {
    Json(v).into_response()
}

async fn health(State(app): State<App>) -> Json<Value> {
    Json(json!({ "status": "healthy", "docker": app.docker.is_some() }))
}

async fn list_providers() -> Json<Value> {
    Json(json!(PROVIDERS.iter().map(|p| json!({
        "id": p.id, "label": p.label, "protocol": p.protocol, "base_url": p.base_url,
        "model": p.model, "key_hint": p.key_hint, "local": p.local, "note": p.note,
    })).collect::<Vec<_>>()))
}

async fn agent_status(State(app): State<App>) -> Json<Value> {
    let (key, base, template) = app.ai_credentials();
    Json(json!({
        "model": app.effective_model(),
        "provider": template.label,
        "provider_id": template.id,
        "base_url": base,
        "key_configured": !key.is_empty() || template.local,
    }))
}

// ---------------------------------------------------------------------------
// Handlers — containers
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default)]
struct ListQuery {
    all: bool,
}

async fn list_containers(State(app): State<App>, Query(q): Query<ListQuery>) -> ApiResult {
    // Default: only containers managed by this platform. ?all=true returns everything on the host.
    let mut builder = ListContainersOptionsBuilder::new().all(true);
    if !q.all {
        let mut filters = HashMap::new();
        filters.insert("label".to_string(), vec![format!("{}={}", MANAGED_LABEL, MANAGED_VALUE)]);
        builder = builder.filters(&filters);
    }
    let opts = builder.build();
    let list = app.docker()?
        .list_containers(Some(opts))
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;

    let mut rows = Vec::new();
    for c in list {
        rows.push(json!({
            "id": c.id.as_deref().map(|i| i.chars().take(12).collect::<String>()).unwrap_or_default(),
            "name": c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default(),
            "status": c.state.as_ref().map(|s| s.to_string()).unwrap_or_else(|| "unknown".into()),
            "image": c.image.clone().unwrap_or_else(|| "unknown".into()),
            "labels": c.labels.clone().unwrap_or_default(),
        }));
    }
    Ok(json_ok(Value::Array(rows)))
}

async fn create_container(State(app): State<App>, headers: axum::http::HeaderMap, Json(req): Json<ContainerCreate>) -> ApiResult {
    app.require_auth(&headers)?;
    let image = req.image.unwrap_or_else(|| app.store.lock().unwrap().config.default_image.clone());
    let mut labels = HashMap::new();
    labels.insert("role".to_string(), req.role.clone());
    labels.insert(MANAGED_LABEL.to_string(), MANAGED_VALUE.to_string());

    let cmd = req.command.clone().or_else(|| {
        if image.starts_with("alpine") {
            Some(vec!["sh".to_string(), "-c".to_string(), "sleep infinity".to_string()])
        } else {
            None
        }
    });

    let config = Config {
        image: Some(image),
        labels: Some(labels),
        env: Some(vec![format!("ROLE={}", req.role)]),
        cmd,
        host_config: Some(bollard::models::HostConfig {
            network_mode: Some(AGENT_NETWORK.to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };

    let docker = app.docker()?;
    let created = docker.create_container(Some(CreateContainerOptions { name: req.name.clone(), platform: None }), config)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;
    docker.start_container(&created.id, None::<StartContainerOptions>)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;
    let inspect = app.inspect(&created.id).await?;

    Ok(json_ok(json!({
        "id": created.id.chars().take(12).collect::<String>(),
        "name": inspect.name.clone().unwrap_or_default().trim_start_matches('/'),
        "status": App::status_of(&inspect),
    })))
}

async fn container_action(State(app): State<App>, headers: axum::http::HeaderMap, Path((ident, action)): Path<(String, String)>) -> ApiResult {
    app.require_auth(&headers)?;
    let docker = app.docker()?;
    let managed = app.inspect_managed(&ident).await?;
    let id = managed.id.clone().unwrap_or_default();
    let result: Result<(), bollard::errors::Error> = match action.as_str() {
        "start" => docker.start_container(&id, None::<StartContainerOptions>).await,
        "stop" => docker.stop_container(&id, None::<StopContainerOptions>).await,
        "restart" => docker.restart_container(&id, None::<RestartContainerOptions>).await,
        other => return Err(err(StatusCode::NOT_FOUND, format!("Unknown action '{other}'"))),
    };
    result.map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;
    let inspect = app.inspect(&id).await?;
    Ok(json_ok(json!({
        "id": id.chars().take(12).collect::<String>(),
        "name": inspect.name.clone().unwrap_or_default().trim_start_matches('/'),
        "status": App::status_of(&inspect),
    })))
}

async fn delete_container(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let id = managed.id.clone().unwrap_or_default();
    app.docker()?
        .remove_container(&id, Some(RemoveContainerOptionsBuilder::new().force(true).build()))
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(json_ok(json!({ "id": ident, "status": "deleted" })))
}

async fn exec_command(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, Json(req): Json<CommandRequest>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let (exit_code, output) = app.exec_in(managed.id.as_deref().unwrap_or_default(), &req.command).await?;
    Ok(json_ok(json!({ "exit_code": exit_code, "output": output })))
}

// ---------------------------------------------------------------------------
// Handlers — stats / inspect / files
// ---------------------------------------------------------------------------

async fn container_stats(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let inspect = app.inspect(&ident).await?;
    let id = inspect.id.clone().unwrap_or_default();
    let opts = StatsOptionsBuilder::new().stream(false).build();
    let mut stream = app.docker()?.stats(&id, Some(opts));
    let stats = stream.next().await
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no stats"))?
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;

    let zero = bollard::models::ContainerCpuStats::default();
    let zero_usage = bollard::models::ContainerCpuUsage::default();
    let cpu = stats.cpu_stats.as_ref().unwrap_or(&zero);
    let pre = stats.precpu_stats.as_ref().unwrap_or(&zero);
    let cpu_total = cpu.cpu_usage.as_ref().unwrap_or(&zero_usage).total_usage.unwrap_or(0) as f64;
    let pre_total = pre.cpu_usage.as_ref().unwrap_or(&zero_usage).total_usage.unwrap_or(0) as f64;
    let cpu_delta = cpu_total - pre_total;
    let sys_delta = cpu.system_cpu_usage.unwrap_or(0) as f64 - pre.system_cpu_usage.unwrap_or(0) as f64;
    let online = cpu.online_cpus
        .map(|n| n as f64)
        .or_else(|| cpu.cpu_usage.as_ref().unwrap_or(&zero_usage).percpu_usage.as_ref().map(|v| v.len() as f64))
        .unwrap_or(1.0)
        .max(1.0);
    let cpu_percent = if sys_delta > 0.0 { (cpu_delta / sys_delta) * online * 100.0 } else { 0.0 };

    let mem = stats.memory_stats.clone().unwrap_or_default();
    let mem_used = mem.usage.unwrap_or(0);
    let mem_limit = mem.limit.unwrap_or(0);
    let (net_rx, net_tx) = stats.networks.as_ref()
        .map(|nws| nws.values().fold((0u64, 0u64), |(rx, tx), n| (rx + n.rx_bytes.unwrap_or(0), tx + n.tx_bytes.unwrap_or(0))))
        .unwrap_or((0, 0));

    Ok(json_ok(json!({
        "cpu_percent": (cpu_percent * 100.0).round() / 100.0,
        "mem_used": mem_used,
        "mem_limit": mem_limit,
        "net_rx": net_rx,
        "net_tx": net_tx,
        "status": App::status_of(&inspect),
    })))
}

async fn container_inspect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let c = app.inspect(&ident).await?;
    let empty = HashMap::new();
    let labels = c.config.as_ref().and_then(|cfg| cfg.labels.as_ref()).unwrap_or(&empty);
    let networks = c.network_settings.as_ref().and_then(|ns| ns.networks.clone()).unwrap_or_default();

    let nets: Vec<Value> = networks.iter().map(|(name, n)| {
        let mut ips: Vec<String> = n.ipam_config.as_ref().into_iter()
            .filter_map(|ipam| ipam.ipv4_address.clone().or_else(|| ipam.ipv6_address.clone()))
            .collect();
        if let Some(ip) = &n.ip_address { if !ip.is_empty() { ips.push(ip.clone()); } }
        ips.retain(|s| !s.is_empty());
        json!({
            "name": name,
            "ip": ips,
            "aliases": n.aliases.clone().unwrap_or_default().into_iter().filter(|a| !a.is_empty()).collect::<Vec<_>>(),
        })
    }).collect();

    let restart_policy = c.host_config.as_ref()
        .and_then(|h| h.restart_policy.as_ref())
        .and_then(|p| p.name.as_ref())
        .map(|n| n.to_string())
        .unwrap_or_else(|| "no".into());

    Ok(json_ok(json!({
        "id": c.id.as_deref().map(|i| i.chars().take(12).collect::<String>()).unwrap_or_default(),
        "name": c.name.clone().unwrap_or_default().trim_start_matches('/'),
        "image": c.config.as_ref().and_then(|cfg| cfg.image.clone()).unwrap_or_default(),
        "created": c.created.as_ref().map(|d| d.to_string()).unwrap_or_default(),
        "state": c.state.as_ref().and_then(|s| s.status.as_ref()).map(|s| s.to_string()).unwrap_or_default(),
        "started_at": c.state.as_ref().and_then(|s| s.started_at.as_ref()).map(|d| d.to_string()).unwrap_or_default(),
        "restart_policy": restart_policy,
        "labels": labels,
        "networks": nets,
    })))
}

#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default = "default_files_path")]
    path: String,
}

fn default_files_path() -> String { "/workspace".into() }

async fn container_files(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, Query(q): Query<FilesQuery>) -> ApiResult {
    app.require_auth(&headers)?;
    let inspect = app.inspect(&ident).await?;
    let status = App::status_of(&inspect);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let cmd = format!("ls -la {} 2>&1 || ls -la /", q.path);
    let (_, output) = app.exec_in(inspect.id.as_deref().unwrap_or_default(), &cmd).await?;
    Ok(json_ok(json!({ "path": q.path, "output": output })))
}

// ---------------------------------------------------------------------------
// Handlers — AI agent command (consult / execute)
// ---------------------------------------------------------------------------

async fn agent_command(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, Json(req): Json<CommandRequest>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }

    let role_label = managed.config.as_ref()
        .and_then(|c| c.labels.as_ref())
        .and_then(|l| l.get("role").cloned())
        .unwrap_or_default();
    let persona = app.store.lock().unwrap().personas.iter().find(|p| p.role == role_label).cloned();
    let base_prompt = persona.map(|p| p.rules_md).unwrap_or_else(|| "You are a capable autonomous Linux agent.".into());
    let model = app.effective_model();

    if req.consult {
        let system = format!(
            "{base_prompt}\n\nAnswer the user in the user's language. Be concise, concrete and senior — like a veteran giving advice to a colleague. Use short markdown lists where helpful. Do NOT invent facts."
        );
        let reply = app.llm(&system, &req.command).await?;
        return Ok(json_ok(json!({ "mode": "consult", "role": role_label, "model": model, "reply": reply })));
    }

    let system = format!(
        "{base_prompt}\n\nYou are operating inside a Linux container (Ubuntu/Alpine, sh shell) as an autonomous agent. The user gives a request in any language. Answer with EXACTLY ONE line containing ONE safe sh command that accomplishes the request using your expertise. Output the bare command only — no markdown, no backticks, no explanation. If the request is a question, answer it with a command that prints the answer (e.g. echo)."
    );
    let reply = app.llm(&system, &req.command).await?;
    let command = reply.trim().trim_matches('`').lines().last().unwrap_or("").trim().to_string();
    if command.is_empty() {
        return Err(err(StatusCode::BAD_GATEWAY, format!("Model returned no usable command: {reply:?}")));
    }
    let (exit_code, output) = app.exec_in(managed.id.as_deref().unwrap_or_default(), &command).await?;
    Ok(json_ok(json!({
        "mode": "execute", "role": role_label, "model": model, "reply": reply,
        "command": command, "exit_code": exit_code, "output": output,
    })))
}

// ---------------------------------------------------------------------------
// Handlers — personas (AI team, editable via UI with markdown rules)
// ---------------------------------------------------------------------------

async fn list_agents(State(app): State<App>) -> ApiResult {
    let personas = app.store.lock().unwrap().personas.clone();
    let mut running: HashMap<String, Value> = HashMap::new();
    if let Some(docker) = app.docker.as_ref() {
        let opts = ListContainersOptionsBuilder::new().all(true).build();
        if let Ok(list) = docker.list_containers(Some(opts)).await {
            for c in list {
                let labels = c.labels.clone().unwrap_or_default();
                if labels.get(MANAGED_LABEL).map(|v| v == MANAGED_VALUE).unwrap_or(false) {
                    if let Some(role) = labels.get("role") {
                        if personas.iter().any(|p| &p.role == role) {
                            running.insert(role.clone(), json!({
                                "name": c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default(),
                                "status": c.state.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                                "id": c.id.as_deref().map(|i| i.chars().take(12).collect::<String>()).unwrap_or_default(),
                            }));
                        }
                    }
                }
            }
        }
    }

    let agents: Vec<Value> = personas.iter().map(|p| json!({
        "role": p.role, "name": p.name, "title": p.title, "years": p.years,
        "expertise": p.expertise, "rules_md": p.rules_md,
        "container": running.get(&p.role),
    })).collect();
    Ok(json_ok(Value::Array(agents)))
}

async fn create_persona(State(app): State<App>, Json(mut p): Json<Persona>) -> ApiResult {
    p.role = p.role.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string();
    if p.role.is_empty() || p.name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "role and name are required"));
    }
    let mut store = app.store.lock().unwrap();
    if store.personas.iter().any(|x| x.role == p.role) {
        return Err(err(StatusCode::CONFLICT, format!("Persona '{}' already exists", p.role)));
    }
    store.personas.push(p.clone());
    drop(store);
    Ok(json_ok(serde_json::to_value(p).unwrap()))
}

async fn update_persona(State(app): State<App>, Path(role): Path<String>, Json(req): Json<PersonaUpdate>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    let p = store.personas.iter_mut().find(|p| p.role == role)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Persona '{role}' not found")))?;
    if let Some(v) = req.name { if !v.is_empty() { p.name = v; } }
    if let Some(v) = req.title { p.title = v; }
    if let Some(v) = req.years { p.years = v; }
    if let Some(v) = req.expertise { p.expertise = v; }
    if let Some(v) = req.rules_md { p.rules_md = v; }
    let out = p.clone();
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_persona(State(app): State<App>, Path(role): Path<String>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    let len = store.personas.len();
    store.personas.retain(|p| p.role != role);
    if store.personas.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Persona '{role}' not found")));
    }
    Ok(json_ok(json!({ "deleted": role })))
}

async fn start_agent(State(app): State<App>, headers: axum::http::HeaderMap, Path(role): Path<String>, body: Option<Json<AgentStartRequest>>) -> ApiResult {
    app.require_auth(&headers)?;
    {
        let store = app.store.lock().unwrap();
        if !store.personas.iter().any(|p| p.role == role) {
            let roles: Vec<String> = store.personas.iter().map(|p| p.role.clone()).collect();
            return Err(err(StatusCode::NOT_FOUND, format!("Unknown role '{role}'. Available: {}", roles.join(", "))));
        }
    }
    let name = body.map(|Json(b)| b.name).flatten().unwrap_or_else(|| format!("agent-{role}"));
    let req = ContainerCreate { name, role, image: None, command: None };
    create_container(State(app), headers, Json(req)).await
}

// ---------------------------------------------------------------------------
// Handlers — tasks
// ---------------------------------------------------------------------------

async fn list_tasks(State(app): State<App>) -> Json<Vec<Task>> {
    Json(app.store.lock().unwrap().tasks.clone())
}

async fn create_task(State(app): State<App>, Json(req): Json<TaskCreate>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    store.task_counter += 1;
    let status = match req.status.as_str() {
        "todo" | "in_progress" | "done" => req.status.clone(),
        _ => "todo".to_string(),
    };
    let task = Task {
        id: format!("t-{:03}", store.task_counter),
        title: req.title,
        description: if req.description.is_empty() { None } else { Some(req.description) },
        status,
        category: req.category,
        priority: req.priority,
        agent: req.assign_to.unwrap_or(req.agent),
        due: req.due,
    };
    store.tasks.push(task.clone());
    drop(store);
    Ok(json_ok(serde_json::to_value(task).unwrap()))
}

async fn delete_task(State(app): State<App>, Path(task_id): Path<String>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    let len = store.tasks.len();
    store.tasks.retain(|t| t.id != task_id);
    if store.tasks.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Task '{task_id}' not found")));
    }
    Ok(json_ok(json!({ "deleted": task_id })))
}

// ---------------------------------------------------------------------------
// Handlers — config & skills
// ---------------------------------------------------------------------------

fn config_json(cfg: &AiConfig) -> Value {
    let masked = if cfg.ai_api_key.is_empty() {
        String::new()
    } else {
        let tail: String = cfg.ai_api_key.chars().skip(cfg.ai_api_key.len().saturating_sub(4)).collect();
        format!("••••{tail}")
    };
    json!({
        "default_model": cfg.default_model,
        "default_image": cfg.default_image,
        "max_containers": cfg.max_containers,
        "auto_restart": cfg.auto_restart,
        "ai_provider": cfg.ai_provider,
        "ai_base_url": cfg.ai_base_url,
        "ai_model": cfg.ai_model,
        "ai_api_key_masked": masked,
        "admin_password_set": !cfg.admin_password_hash.is_empty(),
        "auth_required": auth_enabled(),
    })
}

async fn get_config(State(app): State<App>) -> Json<Value> {
    Json(config_json(&app.store.lock().unwrap().config))
}

async fn update_config(State(app): State<App>, Json(req): Json<ConfigUpdate>) -> ApiResult {
    if let Some(p) = req.ai_provider.as_deref() {
        if provider_template(p).is_none() {
            let ids: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
            return Err(err(StatusCode::BAD_REQUEST, format!("ai_provider must be one of: {}", ids.join(", "))));
        }
    }
    {
        let mut store = app.store.lock().unwrap();
        let cfg = &mut store.config;
        if let Some(v) = req.default_model.clone() { if !v.is_empty() { cfg.default_model = v; } }
        if let Some(v) = req.default_image.clone() { if !v.is_empty() { cfg.default_image = v; } }
        if let Some(v) = req.max_containers { cfg.max_containers = v; }
        if let Some(v) = req.auto_restart { cfg.auto_restart = v; }
        if let Some(v) = req.ai_provider { cfg.ai_provider = v; }
        if let Some(v) = req.ai_base_url { cfg.ai_base_url = v; }
        if let Some(v) = req.ai_model { cfg.ai_model = v; }
        if let Some(v) = req.ai_api_key { if !v.is_empty() { cfg.ai_api_key = v; } }
        if let Some(v) = req.admin_password { cfg.admin_password_hash = sha256_hex(v.trim()); }
    }
    let cfg = app.store.lock().unwrap().config.clone();
    Ok(json_ok(config_json(&cfg)))
}

async fn list_skills(State(app): State<App>) -> Json<Vec<Skill>> {
    Json(app.store.lock().unwrap().skills.clone())
}

async fn create_skill(State(app): State<App>, Json(req): Json<SkillCreate>) -> ApiResult {
    let id: String = req.name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-').to_string();
    let id = if id.is_empty() {
        format!("skill-{}", app.seq.fetch_add(1, Ordering::SeqCst))
    } else {
        id
    };
    let mut store = app.store.lock().unwrap();
    if store.skills.iter().any(|s| s.id == id) {
        return Err(err(StatusCode::CONFLICT, format!("Skill '{id}' already exists")));
    }
    let skill = Skill { id, name: req.name, description: req.description, enabled: true };
    store.skills.push(skill.clone());
    drop(store);
    Ok(json_ok(serde_json::to_value(skill).unwrap()))
}

async fn update_skill(State(app): State<App>, Path(skill_id): Path<String>, Json(req): Json<SkillUpdate>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    let skill = store.skills.iter_mut().find(|s| s.id == skill_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")))?;
    skill.enabled = req.enabled;
    let out = skill.clone();
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_skill(State(app): State<App>, Path(skill_id): Path<String>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    let len = store.skills.len();
    store.skills.retain(|s| s.id != skill_id);
    if store.skills.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")));
    }
    Ok(json_ok(json!({ "deleted": skill_id })))
}

// ---------------------------------------------------------------------------
// Handlers — projects (team builder with react flow graphs)
// ---------------------------------------------------------------------------

async fn list_projects(State(app): State<App>) -> Json<Vec<Project>> {
    Json(app.store.lock().unwrap().projects.clone())
}

async fn create_project(State(app): State<App>, Json(req): Json<ProjectCreate>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    store.project_counter += 1;
    let project = Project {
        id: format!("p-{:03}", store.project_counter),
        name: req.name,
        description: req.description,
        agents: Vec::new(),
        links: Vec::new(),
        positions: HashMap::new(),
    };
    store.projects.push(project.clone());
    drop(store);
    Ok(json_ok(serde_json::to_value(project).unwrap()))
}

async fn get_project(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let store = app.store.lock().unwrap();
    let p = store.projects.iter().find(|p| p.id == id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")))?;
    Ok(json_ok(serde_json::to_value(p).unwrap()))
}

async fn update_project(State(app): State<App>, Path(id): Path<String>, Json(req): Json<ProjectUpdate>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    // Validate that every agent role exists as a persona (before mutable borrow)
    if let Some(agents) = &req.agents {
        for role in agents {
            if !store.personas.iter().any(|p| &p.role == role) {
                return Err(err(StatusCode::BAD_REQUEST, format!("Unknown persona role '{role}'")));
            }
        }
    }
    let p = store.projects.iter_mut().find(|p| p.id == id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")))?;

    if let Some(v) = req.name { if !v.is_empty() { p.name = v; } }
    if let Some(v) = req.description { p.description = v; }
    if let Some(v) = req.agents { p.agents = v; }
    if let Some(v) = req.links { p.links = v; }
    if let Some(v) = req.positions { p.positions = v; }
    let out = p.clone();
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_project(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let mut store = app.store.lock().unwrap();
    let len = store.projects.len();
    store.projects.retain(|p| p.id != id);
    if store.projects.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
    }
    Ok(json_ok(json!({ "deleted": id })))
}

// ---------------------------------------------------------------------------
// Admin auth — one password gates console access to all containers
// ---------------------------------------------------------------------------

async fn verify_admin(State(app): State<App>, Json(req): Json<AuthVerify>) -> Json<Value> {
    let hash = app.store.lock().unwrap().config.admin_password_hash.clone();
    Json(json!({ "ok": !hash.is_empty() && sha256_hex(&req.password) == hash }))
}

// ---------------------------------------------------------------------------
// Web UI login — ADMIN_USER / ADMIN_PASSWORD from .env; empty password = auth disabled
// ---------------------------------------------------------------------------

fn auth_enabled() -> bool {
    !std::env::var("ADMIN_PASSWORD").unwrap_or_default().trim().is_empty()
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn login(State(app): State<App>, Json(req): Json<LoginRequest>) -> ApiResult {
    if !auth_enabled() {
        return Err(err(StatusCode::NOT_FOUND, "Authentication is disabled (no ADMIN_PASSWORD in .env)"));
    }
    let user = std::env::var("ADMIN_USER").unwrap_or_else(|_| "admin".into());
    let pass = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
    if req.username != user || req.password != pass {
        return Err(err(StatusCode::UNAUTHORIZED, "Invalid username or password"));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let token = sha256_hex(&format!("{}:{}:{nanos}", req.username, req.password));
    app.store.lock().unwrap().sessions.insert(token.clone(), req.username.clone());
    Ok(json_ok(json!({ "ok": true, "token": token, "user": req.username })))
}

async fn logout(State(app): State<App>, Json(req): Json<AuthVerify>) -> Json<Value> {
    let mut store = app.store.lock().unwrap();
    store.sessions.remove(&req.password); // password field carries the token here
    Json(json!({ "ok": true }))
}

async fn me(State(app): State<App>, headers: axum::http::HeaderMap) -> Json<Value> {
    let token = headers.get("x-session-token").and_then(|t| t.to_str().ok()).unwrap_or("");
    let store = app.store.lock().unwrap();
    let user = store.sessions.get(token).cloned();
    Json(json!({ "auth_required": auth_enabled(), "valid": user.is_some(), "user": user }))
}

impl App {
    /// Container access guard: when auth is enabled, mutating/console endpoints need a valid session.
    fn require_auth(&self, headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
        if !auth_enabled() {
            return Ok(());
        }
        let token = headers.get("x-session-token").and_then(|t| t.to_str().ok()).unwrap_or("");
        let store = self.store.lock().unwrap();
        if store.sessions.contains_key(token) {
            Ok(())
        } else {
            Err(err(StatusCode::UNAUTHORIZED, "Login required"))
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let docker = Docker::connect_with_local_defaults().ok();
    if docker.is_none() {
        eprintln!("Docker client init failed — running without container management");
    }

    let app_state = App {
        docker,
        store: Arc::new(Mutex::new(Store::default())),
        seq: Arc::new(AtomicUsize::new(1)),
    };

    let cors = tower_http::cors::CorsLayer::permissive();

    let router = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/providers", get(list_providers))
        .route("/agent/status", get(agent_status))
        .route("/auth/verify", post(verify_admin))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/containers", get(list_containers).post(create_container))
        .route("/containers/{ident}", delete(delete_container))
        .route("/containers/{ident}/{action}", post(container_action))
        .route("/containers/{ident}/exec", post(exec_command))
        .route("/containers/{ident}/agent", post(agent_command))
        .route("/containers/{ident}/stats", get(container_stats))
        .route("/containers/{ident}/inspect", get(container_inspect))
        .route("/containers/{ident}/files", get(container_files))
        .route("/agents", get(list_agents).post(create_persona))
        .route("/agents/{role}", put(update_persona).delete(delete_persona))
        .route("/agents/{role}/start", post(start_agent))
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{task_id}", delete(delete_task))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{id}", get(get_project).put(update_project).delete(delete_project))
        .route("/config", get(get_config).put(update_config))
        .route("/skills", get(list_skills).post(create_skill))
        .route("/skills/{skill_id}", put(update_skill).delete(delete_skill))
        .fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({ "detail": "Not Found" }))) })
        .layer(cors)
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.expect("bind :8000");
    println!("{SERVICE_NAME} listening on :8000");
    axum::serve(listener, router).await.expect("server error");
}
