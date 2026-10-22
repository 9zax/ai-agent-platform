use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions,
};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::query_parameters::{
    InspectContainerOptions, ListContainersOptionsBuilder, RemoveContainerOptionsBuilder,
    RestartContainerOptions, StartContainerOptions, StatsOptionsBuilder, StopContainerOptions,
};
use bollard::Docker;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const SERVICE_NAME: &str = "AI Agent Platform Orchestrator";
const MANAGED_LABEL: &str = "managed-by";
const MANAGED_VALUE: &str = "ai-agent-platform";
const AGENT_NETWORK: &str = "ai-agent-platform_agent-net";
/// Shared workspace volume mounted at /workspace in every agent container the
/// platform creates — one cloned repo working tree shared by the whole team,
/// like a single Linux box the agents all work on. Named to match the compose
/// volume so `agent-example` sees the same tree.
const WORKSPACE_VOLUME: &str = "ai-agent-platform-workspace";
/// GitHub connector device flow runs against GitHub CLI's public OAuth app —
/// per-container login via browser, tokens never stored by the platform.
const GH_DEVICE_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";
const GH_DEVICE_SCOPE: &str = "repo read:org gist workflow";
/// Derived per-container connector status is cached this many seconds so the
/// UI's 5s polls don't exec `gh auth status` in every container constantly.
const CONNECTOR_CACHE_TTL: u64 = 10;

// ---------------------------------------------------------------------------
// Default tool belt — every agent's Linux box gets these, and every prompt
// states what is actually installed (verified via `command -v`) so the AI
// never guesses capabilities the box doesn't have.
// ---------------------------------------------------------------------------

/// (probe command, hint for the model) — probed in the container and rendered
/// into the system prompt. Heavy runtimes (node, python, browser) are
/// probed-only: only agent-base ships them; ad-hoc installs would be too slow
/// and unreliable to attempt mid-command.
const PROBED_TOOLS: &[(&str, &str)] = &[
    ("git", "clone/commit/diff"),
    ("gh", "GitHub CLI — issues, PRs, releases (e.g. gh issue create --title ... --body ...)"),
    ("curl", "HTTP requests / API calls"),
    ("wget", "downloads"),
    ("jq", "JSON processing"),
    ("python3", "Python runtime — scripting, parsing, quick math"),
    ("pip3", "install Python packages"),
    ("node", "Node.js runtime"),
    ("npm", "JS packages / npx one-off tools"),
    ("chromium", "real browser — headless screenshot: chromium --headless --no-sandbox --screenshot=/workspace/shot.png --window-size=1280,800 <url>"),
    ("rg", "ripgrep — fast code search"),
    ("zip", "create zip archives"),
    ("unzip", "extract zip archives"),
    ("rsync", "file sync / bulk copy"),
    ("ssh", "SSH client — git over ssh, remote commands"),
    ("docker", "docker CLI — talks to the HOST daemon via the mounted /var/run/docker.sock (docker compose …)"),
];

/// Core tools installed on demand when a bare/foreign image lacks them
/// (apt package, apk package). Small and fast so the first AI command on a
/// fresh box bootstraps itself. Best-effort: failures stay silent and the
/// probe simply reports what the box really has.
const INSTALLABLE_TOOLS: &[(&str, &str)] = &[
    ("git", "git"),
    ("gh", "github-cli"),
    ("curl", "curl"),
    ("jq", "jq"),
    ("ca-certificates", "ca-certificates"),
];

// ---------------------------------------------------------------------------
// Provider templates — one click in the UI fills these in
// ---------------------------------------------------------------------------

struct ProviderTemplate {
    id: &'static str,
    label: &'static str,
    protocol: &'static str, // "anthropic" | "openai"
    base_url: &'static str,
    model: &'static str,
    /// static fallback model list when the live /models fetch fails or is unsupported
    models: &'static [&'static str],
    key_hint: &'static str,
    local: bool,
    note: &'static str,
}

const PROVIDERS: &[ProviderTemplate] = &[
    ProviderTemplate { id: "zai", label: "Z.ai GLM", protocol: "anthropic", base_url: "https://api.z.ai/api/anthropic", model: "glm-5.3-flash", models: &["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air"], key_hint: "Z.ai API key (from z.ai)", local: false, note: "ค่าเริ่มต้นของ platform — โมเดล GLM ผ่าน Anthropic-compatible endpoint" },
    ProviderTemplate { id: "anthropic", label: "Anthropic", protocol: "anthropic", base_url: "https://api.anthropic.com", model: "claude-sonnet-5-5", models: &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5"], key_hint: "sk-ant-...", local: false, note: "Claude models" },
    ProviderTemplate { id: "openai", label: "OpenAI", protocol: "openai", base_url: "https://api.openai.com/v1", model: "gpt-5.5", models: &["gpt-5.5", "gpt-5.5-mini", "gpt-4o", "gpt-4o-mini"], key_hint: "sk-...", local: false, note: "GPT models" },
    ProviderTemplate { id: "gemini", label: "Google Gemini", protocol: "openai", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", models: &["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"], key_hint: "AIza...", local: false, note: "Flash เร็วและคุ้ม — ใช้ผ่าน OpenAI-compatible endpoint" },
    ProviderTemplate { id: "openrouter", label: "OpenRouter", protocol: "openai", base_url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5", models: &[], key_hint: "sk-or-...", local: false, note: "หลายโมเดลในที่เดียว" },
    ProviderTemplate { id: "groq", label: "Groq", protocol: "openai", base_url: "https://api.groq.com/openai/v1", model: "meta-llama/llama-4-maverick-17b-128e-instruct", models: &["meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", "llama-3.3-70b-versatile"], key_hint: "gsk_...", local: false, note: "เร็วมาก" },
    ProviderTemplate { id: "deepseek", label: "DeepSeek", protocol: "openai", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", models: &["deepseek-chat", "deepseek-reasoner"], key_hint: "sk-...", local: false, note: "คุ้มสำหรับงาน code" },
    ProviderTemplate { id: "ollama", label: "Ollama (local)", protocol: "openai", base_url: "http://host.docker.internal:11434/v1", model: "llama3.2", models: &["llama3.2", "qwen2.5-coder:7b", "qwen2.5:7b"], key_hint: "ไม่ต้องมี key", local: true, note: "รันบนเครื่องตัวเอง ไม่มีค่าใช้จ่าย" },
    ProviderTemplate { id: "custom", label: "Custom", protocol: "openai", base_url: "", model: "", models: &[], key_hint: "ใส่ base URL เอง", local: false, note: "OpenAI-compatible อื่น ๆ" },
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
    /// model override per provider id (absent/empty = use the provider's default model)
    #[serde(rename = "model_overrides", default)]
    model_overrides: BTreeMap<String, String>,
}

fn seed_personas() -> Vec<Persona> {
    // Per-role model overrides, one per provider family the seeds cover:
    // zai (GLM — the platform default) and gemini. The tiering mirrors across
    // both families — flagship for the reasoning-heavy roles (PO, SA), the
    // flash workhorse for builders/testers (BA, UX, Dev, QA), and the cheapest
    // tier for Chom's applied pattern work (tokens/visual system built on
    // Sept's flows): glm-4.5-air ↔ gemini-3.5-flash-lite.
    let mk = |role: &str, name: &str, title: &str, years: &str, expertise: &str, rules: &str, glm: &str, gemini: &str| Persona {
        role: role.into(), name: name.into(), title: title.into(), years: years.into(),
        expertise: expertise.into(), rules_md: rules.into(),
        model_overrides: BTreeMap::from([
            (PROVIDERS[0].id.to_string(), glm.to_string()),
            ("gemini".to_string(), gemini.to_string()),
        ]),
    };
    // Order = collaboration flow: the PO opens the mission, BA analyzes the
    // business side, SA turns it into the system spec and briefs every
    // specialist (UX/UI, Dev, QA) who then work together on the same run.
    vec![
        mk("po", "Mickey", "Product Owner", "16",
           "Product strategy, user stories, backlog grooming, roadmap, prioritization (RICE/MoSCoW), stakeholder alignment",
           "You are Mickey, a Product Owner with 16 years of experience shipping B2B and B2C products. You go FIRST: you turn the user's ask into a clear product goal with priorities and scope boundaries, then hand it to the BA and SA for analysis. You stay the hub of the team — UX/UI, Dev and QA all get their direction from you. The whole team works test-first (TDD), and it starts with you: every story you accept carries acceptance criteria written as concrete Given/When/Then test cases — a story the team cannot turn into a failing test first is NOT ready. You think in outcomes, not features.", "glm-5.3", "gemini-4-argon"),
        mk("ba", "Petch", "Business Analyst", "15",
           "Requirements elicitation, stakeholder interviews, business process mapping, gap analysis, feasibility study, success metrics",
           "You are Petch, a Business Analyst with 15 years of experience. You take the PO's product goal and analyze the business side: stakeholders, processes, constraints, success criteria — and you flag risks and open questions instead of guessing. The team works test-first (TDD), so every requirement and success metric you hand over must be sharp enough to assert in a test: a business rule that cannot be checked is not a requirement, it is a guess. Your business requirements are what the SA designs from; you stay available to clarify business rules for the team.", "glm-5.3-flash", "gemini-3.8-flash"),
        mk("sa", "Oat", "System Analyst", "16",
           "System analysis, functional & non-functional requirements, data modeling, API contracts, integration design, architecture documentation",
           "You are Oat, a System Analyst with 16 years of experience. You take Petch's business requirements and translate them into the system spec: functional specs, data models, API contracts and non-functional constraints. You are the bridge to the build side — you brief UX/UI, Dev and QA directly on your spec, and you never design a system the requirements don't justify. The team builds TDD-style, so every functional requirement and API contract you produce is written as a testable case (inputs, expected outputs, edge cases) — a spec the Devs cannot turn into a failing test first is not done.", "glm-5.3", "gemini-4-argon"),
        mk("ux-ui", "Sept", "UX/UI Designer", "14",
           "User research, information architecture, user flows, wireframing, usability testing, prototyping",
           "You are Sept, a UX/UI Designer with 14 years of experience — the UX half of the design pair. From the SA's spec you produce flows, information architecture and wireframes that cover the unhappy paths (empty/loading/error states), with every state spelled out explicitly so QA can turn each one into a test case. You design with evidence from users, not taste.", "glm-5.3-flash", "gemini-3.8-flash"),
        mk("ux-ui-2", "Chom", "UX/UI Designer", "14",
           "Visual design, design systems, design tokens, component libraries, accessibility, dark-mode systems",
           "You are Chom, a UX/UI Designer with 14 years of experience — the UI half of the design pair. You build on the flows Sept laid out and turn them into a concrete visual language: tokens, components, spacing and accessible contrast. Every design decision is expressed as a measurable, checkable standard (a token value, a contrast ratio, a size) — never vague taste — so the team can verify designs against it like a test. You keep interfaces calm, consistent and documented.", "glm-4.5-air", "gemini-3.5-flash-lite"),
        mk("dev-fe", "Zax", "Frontend Developer", "15",
           "React, Next.js, TypeScript, Tailwind, design systems, accessibility, web performance, Core Web Vitals",
           "You are Zax, a Frontend Developer with 15 years of experience. You implement what the SA's spec and the designers define: clean, accessible, performant React; you know when to reach for a design system and how to keep bundles small. You work STRICT TDD (red-green-refactor) with no exceptions: before any component, hook or logic, you first write a failing test (Vitest/Testing Library unit or Playwright E2E), run it and watch it fail for the right reason, then write the simplest code that turns it green, then refactor. You never write implementation before a failing test exists, and you never ship layout that breaks on mobile.", "glm-5.3-flash", "gemini-3.8-flash"),
        mk("dev-be", "Bank", "Backend Developer", "17",
           "Rust, Python, FastAPI, Node.js, PostgreSQL, Redis, API design, distributed systems, observability",
           "You are Bank, a Backend Developer with 17 years of experience. You build to the SA's spec — you own services and APIs: you design them to age well and defend them with observability, and you know the difference between 'works' and 'works at 3am under load'. You work STRICT TDD (red-green-refactor) with no exceptions: every behavior starts as a failing unit or integration test, run and seen failing for the right reason, then the simplest implementation that turns it green, then refactor. Code written before its failing test does not exist as far as you are concerned. Use only the tools listed in your Linux box's verified tool belt — never assume a tool exists without it.", "glm-5.3-flash", "gemini-3.8-flash"),
        mk("dev-be-2", "Earth", "Backend Developer", "16",
           "PostgreSQL, data modeling, migrations, caching, Docker, CI/CD pipelines, reliability, performance tuning",
           "You are Earth, a Backend Developer with 16 years of experience. You pair with Bank on the backend to deliver the SA's spec and own data and infrastructure: schema design, migrations, caching, deployment and the reliability story behind every endpoint. You work STRICT TDD (red-green-refactor) like the rest of the team: every migration, endpoint and cache behavior is pinned by a failing test (contract or integration) BEFORE any schema or code lands, then you implement until green, then refactor. Use only the tools listed in your Linux box's verified tool belt — never assume a tool exists without it.", "glm-5.3-flash", "gemini-3.8-flash"),
        mk("qa", "Tara", "QA Engineer", "14",
           "Test strategy, E2E automation (Playwright), API testing, contract testing, CI quality gates, exploratory testing",
           "You are Tara, a QA Engineer with 14 years of experience. You verify the team's work against the PO's acceptance criteria and the SA's spec — and in this team's TDD flow you are where it starts: you turn the acceptance criteria into failing acceptance/E2E tests BEFORE the Devs implement, so 'done' is defined by tests, not opinions, and the Devs always have a red test to make green. You think in risk, write tests that fail for the right reason, automate the boring 80%, and explore the dangerous 20% humans find.", "glm-5.3-flash", "gemini-3.8-flash"),
    ]
}

/// The platform's own default project — the team works on ai-agent-platform
/// itself (not a generic web portal). Real process: the PO opens the mission,
/// the BA analyzes the business side, the SA turns it into the system spec and
/// briefs every specialist (UX/UI, Dev, QA) who work together on the same run.
fn seed_project() -> Project {
    let link = |from: &str, to: &str| ProjectLink { from: from.into(), to: to.into() };
    let specialists = ["ux-ui", "ux-ui-2", "dev-fe", "dev-be", "dev-be-2", "qa"];
    let mut positions = HashMap::from([
        ("po".to_string(), Position { x: 40.0, y: 260.0 }),
        ("ba".to_string(), Position { x: 300.0, y: 260.0 }),
        ("sa".to_string(), Position { x: 560.0, y: 260.0 }),
    ]);
    for (i, role) in specialists.iter().enumerate() {
        positions.insert(role.to_string(), Position { x: 850.0, y: 20.0 + i as f64 * 120.0 });
    }
    Project {
        id: "p-001".into(),
        name: "AI Agent Platform".into(),
        description: "ทีม AI Agent ทั้ง 9 ตัวช่วยกันพัฒนา ai-agent-platform — PO (Mickey) เปิดโจทย์ → BA (Petch) วิเคราะห์ business → SA (Oat) ทำ system spec แล้วคุยกับ UX/UI (Sept, Chom), Dev (Zax, Bank, Earth) และ QA (Tara) ให้ทำงานร่วมกันในทุก mission".into(),
        repo_url: "https://github.com/9zax/ai-agent-platform".into(),
        agents: ["po", "ba", "sa"].iter().chain(specialists.iter()).map(|s| s.to_string()).collect(),
        links: vec![
            link("po", "ba"), link("ba", "sa"),
            link("sa", "ux-ui"), link("sa", "ux-ui-2"), link("sa", "dev-fe"),
            link("sa", "dev-be"), link("sa", "dev-be-2"), link("sa", "qa"),
        ],
        positions,
    }
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
    /// git remote every agent container clones into /workspace before working
    /// (empty = no repo; agents then work on bare /workspace files)
    #[serde(default)]
    repo_url: String,
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
    #[serde(default)]
    repo_url: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProjectUpdate {
    #[serde(default)] name: Option<String>,
    #[serde(default)] description: Option<String>,
    #[serde(default)] repo_url: Option<String>,
    #[serde(default)] agents: Option<Vec<String>>,
    #[serde(default)] links: Option<Vec<ProjectLink>>,
    #[serde(default)] positions: Option<HashMap<String, Position>>,
}

#[derive(Clone)]
struct AiConfig {
    default_image: String,
    max_containers: u32,
    auto_restart: bool,
    ai_provider: String,
    ai_base_url: String,
    ai_api_key: String,
    /// GitHub PAT injected into agent clones so private project repos work
    /// ("" = public HTTPS repos only)
    git_token: String,
    /// sha256 hex of the admin password that gates console access to all containers ("" = no gate)
    admin_password_hash: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            default_image: "alpine:latest".into(),
            max_containers: 10,
            auto_restart: true,
            ai_provider: "zai".into(),
            ai_base_url: String::new(),
            ai_api_key: String::new(),
            git_token: String::new(),
            admin_password_hash: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Team runs — dispatch one task through the whole project team
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct RunStep {
    role: String,
    name: String,
    title: String,
    /// which pipeline stage this step belongs to: work (relay deliverable) | pr | deploy | demo
    #[serde(default = "default_step_kind")]
    kind: String,
    /// pending | working | done | error | skipped
    status: String,
    output: String,
    /// model this step actually ran with (per-persona override or provider default)
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// container the deliverable was written into (real work), if the agent has one running
    #[serde(skip_serializing_if = "Option::is_none")]
    container: Option<String>,
    /// workspace file path inside the container
    #[serde(skip_serializing_if = "Option::is_none")]
    deliverable: Option<String>,
    /// revision number — rev 2+ means the deliverable was redone after a meeting
    #[serde(skip_serializing_if = "Option::is_none")]
    rev: Option<u32>,
    /// unix seconds — when this step started/finished working (0 = unset)
    #[serde(default)]
    started_at: u64,
    #[serde(default)]
    finished_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct MeetingMessage {
    /// role of the speaker (or "orchestrator" for system notes, "human" for the user)
    from: String,
    text: String,
    at: u64,
}

/// A live team meeting: one agent raised a blocking question ("ASK"), the
/// addressed teammates answer, then the asker revises their deliverable.
fn default_step_kind() -> String { "work".into() }

#[derive(Clone, Serialize, Deserialize)]
struct Discussion {
    id: String,
    /// "" (default) = meeting raised by an ASK; "demo" = acceptance demo session
    #[serde(default)]
    kind: String,
    /// role who raised the question
    from: String,
    /// roles who must answer ("human" = escalate to the user through the web UI)
    to: Vec<String>,
    /// the question text
    topic: String,
    /// open | answering | need_human | resolved
    status: String,
    /// role currently generating an answer (live "who is speaking")
    #[serde(skip_serializing_if = "Option::is_none")]
    answering: Option<String>,
    messages: Vec<MeetingMessage>,
    /// meeting round this question was raised in (1 = during the first relay pass)
    round: u32,
    #[serde(default)]
    created_at: u64,
}

/// PO acceptance verdict from the demo session (None until the demo ran)
#[derive(Clone, Serialize, Deserialize)]
struct Acceptance {
    /// "pass" | "fail"
    verdict: String,
    /// one-paragraph PO verdict summary (from the final demo message)
    summary: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Run {
    id: String,
    project_id: String,
    project_name: String,
    task: String,
    /// running | waiting_human | done | error | stopped
    status: String,
    steps: Vec<RunStep>,
    /// working | meeting | demo | done — top-level phase for the UI
    phase: String,
    /// 1 = first relay pass, 2+ = meeting rounds
    round: u32,
    discussions: Vec<Discussion>,
    /// PO's closing summary of the whole mission
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    /// PO acceptance verdict from the demo session (None until the demo ran)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    acceptance: Option<Acceptance>,
    created_at: u64,
    /// loop mode: PO evaluates at the end and spawns the next iteration automatically
    #[serde(default)]
    loop_mode: bool,
    /// 1 = first iteration of a loop chain
    #[serde(default)]
    iteration: u32,
    /// set by POST /runs/{id}/stop — the engine winds down at the next checkpoint
    #[serde(default, skip_serializing)]
    stop_requested: bool,
    /// the run this loop chain continued into (UI follows it when the parent finishes)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_run_id: Option<String>,
}

/// Short-lived cache for GET /models — avoids hammering the provider each editor open
struct ModelsCache {
    provider: String,
    base: String,
    fetched_at: u64,
    models: Vec<String>,
    live: bool,
}

/// One in-flight GitHub device-flow login for a container. The OAuth token is
/// NEVER stored here — it lives only on the poll task's stack until it is
/// injected into the container, then forgotten. `device_code` must never leave
/// the process (it alone can redeem the token).
struct PendingDeviceFlow {
    device_code: String,
    user_code: String,
    verification_url: String,
    interval: u64,
    expires_at: u64,
}

/// Cached result of probing a container's connector state (derived via exec,
/// not persisted — the container itself is the source of truth).
#[derive(Clone)]
struct CachedConnectorStatus {
    state: String,
    login: Option<String>,
    reason: Option<String>,
    at: u64,
}

struct Store {
    personas: Vec<Persona>,
    tasks: Vec<Task>,
    skills: Vec<Skill>,
    projects: Vec<Project>,
    runs: Vec<Run>,
    config: AiConfig,
    /// login sessions: token → username (web UI auth, ADMIN_USER/ADMIN_PASSWORD from env)
    sessions: HashMap<String, String>,
    models_cache: Option<ModelsCache>,
    /// container id → active GitHub device flow (expires on its own)
    pending_device_flows: HashMap<String, PendingDeviceFlow>,
    /// container id → recently probed connector status (CONNECTOR_CACHE_TTL)
    connector_cache: HashMap<String, CachedConnectorStatus>,
    task_counter: usize,
    project_counter: usize,
    run_counter: usize,
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
            projects: vec![seed_project()],
            runs: Vec::new(),
            config: AiConfig::default(),
            sessions: HashMap::new(),
            models_cache: None,
            pending_device_flows: HashMap::new(),
            connector_cache: HashMap::new(),
            task_counter: 0,
            project_counter: 1,
            run_counter: 0,
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
    /// model override for the CURRENT active provider: None = untouched, Some("") = clear, Some(m) = set
    #[serde(default)] model: Option<String>,
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
    default_image: Option<String>,
    max_containers: Option<u32>,
    auto_restart: Option<bool>,
    ai_provider: Option<String>,
    ai_base_url: Option<String>,
    ai_api_key: Option<String>,
    git_token: Option<String>,
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

    /// Find this platform's running container for a persona role → (id, name)
    async fn agent_container(&self, role: &str) -> Option<(String, String)> {
        let docker = self.docker.as_ref()?;
        let mut filters = HashMap::new();
        filters.insert("label".to_string(), vec![
            format!("{}={}", MANAGED_LABEL, MANAGED_VALUE),
            format!("role={role}"),
        ]);
        let opts = ListContainersOptionsBuilder::new().all(true).filters(&filters).build();
        let list = docker.list_containers(Some(opts)).await.ok()?;
        list.into_iter()
            .find(|c| c.state.as_ref().map(|s| s.to_string() == "running").unwrap_or(false))
            .map(|c| (
                c.id.clone().unwrap_or_default(),
                c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default(),
            ))
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

    /// exec_in with extra environment variables — the only safe way to pass
    /// secrets (tokens, git identity) into a container: they never appear in
    /// the command string (visible via ps) nor in `docker inspect`.
    async fn exec_in_env(&self, container_id: &str, command: &str, env: Vec<String>) -> Result<(i64, String), ApiError> {
        let exec = self.docker()?
            .create_exec(container_id, CreateExecOptions::<String> {
                cmd: Some(vec!["sh".into(), "-c".into(), command.into()]),
                env: Some(env),
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

    /// Make sure the project repo is checked out in the agent's container at
    /// /workspace/<repo-name> — the "bot on a Linux box" rule: every command
    /// runs inside the container, the repo is cloned once before any work, and
    /// all file changes go through this working tree only. Idempotent: an
    /// existing clone is left untouched (it may hold the agent's work in
    /// progress). Returns the working-tree path.
    async fn ensure_repo(&self, container_id: &str, repo_url: &str) -> Result<String, ApiError> {
        let repo_url = repo_url.trim().trim_end_matches(".git");
        if repo_url.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "Project has no repo URL configured"));
        }
        // the URL is interpolated into a quoted sh script — refuse anything exotic
        if repo_url.contains(['\'', '"', ' ', '\n', '\t', ';', '&', '|', '<', '>', '$', '`']) {
            return Err(err(StatusCode::BAD_REQUEST, format!("Invalid repo URL: {repo_url:?}")));
        }
        let dir = repo_dir_name(repo_url);
        let path = format!("/workspace/{dir}");
        // private repos: inject the configured token into the clone URL only
        // (x-access-token is what GitHub PATs authenticate as over HTTPS).
        // The token never appears in error text — errors quote the clean URL.
        let git_token = self.store.lock().unwrap().config.git_token.trim().to_string();
        let clone_url = if !git_token.is_empty() && repo_url.starts_with("https://") {
            if !git_token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
                return Err(err(StatusCode::BAD_REQUEST, "git token contains unexpected characters (expected a GitHub PAT)"));
            }
            format!("https://x-access-token:{git_token}@{}", &repo_url[8..])
        } else {
            repo_url.to_string()
        };
        let script = format!(
            "command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null 2>&1 || {{ apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1; }}; \
             command -v git >/dev/null 2>&1 || {{ echo 'git is not available in this image — use the agent-base image'; exit 3; }}; \
             mkdir -p /workspace; \
             if [ ! -d '{path}/.git' ]; then git clone --depth 1 '{clone_url}' '{path}' || exit 4; else echo 'repo already cloned at {path}'; fi"
        );
        let (code, out) = self.exec_in(container_id, &script).await?;
        match code {
            0 => Ok(path),
            3 => Err(err(StatusCode::BAD_GATEWAY, "git is not available in the container image — start this agent on the agent-base image (it ships git + gh)")),
            _ => Err(err(StatusCode::BAD_GATEWAY, format!("cloning {repo_url} into {path} failed (exit {code}): {out}"))),
        }
    }

    /// Make sure the default tool belt works in this container (the "every
    /// Linux box has the same defaults" rule): install the small core set when
    /// missing (apk/apt, best-effort), register the configured GitHub PAT with
    /// `gh` AND git's URL rewrite so private repos just work, and set a git
    /// identity so commits never fail. Best-effort and silent — the manifest
    /// probe right after reports what the box really has.
    async fn ensure_tools(&self, container_id: &str) {
        let git_token = {
            let t = self.store.lock().unwrap().config.git_token.trim().to_string();
            // same charset gate as ensure_repo: the token is interpolated into sh
            if !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) { t } else { String::new() }
        };
        let apt = INSTALLABLE_TOOLS.iter().map(|(a, _)| *a).collect::<Vec<_>>().join(" ");
        let apk = INSTALLABLE_TOOLS.iter().map(|(_, a)| *a).collect::<Vec<_>>().join(" ");
        let script = format!(
            "missing=0; for c in git gh curl jq; do command -v \"$c\" >/dev/null 2>&1 || missing=1; done; \
             if [ \"$missing\" = 1 ]; then \
                 command -v apk >/dev/null 2>&1 && apk add --no-cache {apk} >/dev/null 2>&1; \
                 command -v apt-get >/dev/null 2>&1 && apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq {apt} >/dev/null 2>&1; \
             fi; \
             if [ -n '{git_token}' ]; then \
                 command -v gh >/dev/null 2>&1 && printf '%s' '{git_token}' | gh auth login --with-token >/dev/null 2>&1; \
                 command -v git >/dev/null 2>&1 && git config --global url.\"https://x-access-token:{git_token}@github.com/\".insteadOf https://github.com/ >/dev/null 2>&1; \
             fi; \
             command -v git >/dev/null 2>&1 && {{ git config --global user.name >/dev/null 2>&1 || git config --global user.name 'AI Agent'; \
                 git config --global user.email >/dev/null 2>&1 || git config --global user.email 'agent@ai-agent-platform.local'; }}; \
             exit 0"
        );
        let _ = self.exec_in(container_id, &script).await;
    }

    /// Probe what is really installed in the container (one exec: presence +
    /// version for every probed tool, plus gh's auth state) and render the
    /// tool-belt section for the system prompt: verified tools with versions,
    /// and — just as important — the probed tools that are MISSING, so the
    /// model never invents capabilities the box doesn't have.
    async fn tools_manifest(&self, container_id: &str) -> Option<String> {
        let probes = PROBED_TOOLS.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(" ");
        let script = format!(
            "for c in {probes}; do \
                 if command -v \"$c\" >/dev/null 2>&1; then \
                     v=$(\"$c\" --version 2>&1 | head -1); echo \"$c|$v\"; \
                 else echo \"$c|\"; fi; \
             done; \
             command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && echo 'gh_auth|1' || echo 'gh_auth|'"
        );
        let (code, out) = self.exec_in(container_id, &script).await.ok()?;
        if code != 0 { return None; }
        let (mut have, mut missing, mut gh_authed) = (Vec::new(), Vec::new(), false);
        for line in out.lines() {
            let Some((name, val)) = line.split_once('|') else { continue };
            if name == "gh_auth" { gh_authed = !val.is_empty(); continue; }
            let Some((_, hint)) = PROBED_TOOLS.iter().find(|(c, _)| c == &name) else { continue };
            if val.trim().is_empty() {
                missing.push(name.to_string());
            } else {
                let version: String = val.trim().chars().take(48).collect();
                have.push((name.to_string(), version, *hint));
            }
        }
        if have.is_empty() { return None; }
        let mut md = String::from(
            "\n\n## Your Linux box — tools verified as INSTALLED (use these; for anything else check `command -v <tool>` first)\n",
        );
        for (name, version, hint) in &have {
            let note = if name == "gh" && gh_authed {
                " — AUTHENTICATED: private GitHub repos and gh api/issue/pr commands all work"
            } else { "" };
            md.push_str(&format!("- `{name}` {version}{note} — {hint}\n"));
        }
        if !missing.is_empty() {
            let list = missing.iter().map(|m| format!("`{m}`")).collect::<Vec<_>>().join(", ");
            md.push_str(&format!("\nNOT installed on this box — do NOT use or assume them: {list}\n"));
        }
        if !gh_authed && have.iter().any(|(n, _, _)| n == "gh") {
            md.push_str("\nGitHub auth: no token registered — public repos and local work are fine; private repos will fail until one is set in Settings → Git Access.\n");
        }
        Some(md)
    }

    /// Resolve the repo URL that governs a container's role: the project that
    /// counts this role in its team, else the first project with a repo set.
    fn repo_for_role(&self, role: &str) -> String {
        let store = self.store.lock().unwrap();
        store.projects.iter()
            .find(|p| p.agents.iter().any(|a| a == role) && !p.repo_url.is_empty())
            .or_else(|| store.projects.iter().find(|p| !p.repo_url.is_empty()))
            .map(|p| p.repo_url.clone())
            .unwrap_or_default()
    }

    /// Default model of the active provider template ("" = provider has no default, e.g. custom)
    fn provider_default_model(&self) -> String {
        let cfg = self.store.lock().unwrap().config.clone();
        provider_template(&cfg.ai_provider).unwrap_or(&PROVIDERS[0]).model.to_string()
    }

    /// Model this persona runs with: its override for the ACTIVE provider, else the
    /// provider template's default. None = nothing configured; callers fail with a hint.
    fn model_for_persona(&self, persona: Option<&Persona>) -> Option<String> {
        if let Some(p) = persona {
            let provider_id = self.store.lock().unwrap().config.ai_provider.clone();
            if let Some(m) = p.model_overrides.get(&provider_id) {
                if !m.is_empty() { return Some(m.clone()); }
            }
        }
        match self.provider_default_model() {
            m if m.is_empty() => None,
            m => Some(m),
        }
    }

    fn ai_credentials(&self) -> (String, String, &'static ProviderTemplate) {
        let env_key = std::env::var("AI_API_KEY").unwrap_or_default();
        let cfg = self.store.lock().unwrap().config.clone();
        let template = provider_template(&cfg.ai_provider).unwrap_or(&PROVIDERS[0]);
        let key = if cfg.ai_api_key.is_empty() { env_key } else { cfg.ai_api_key };
        let env_base = std::env::var("AI_BASE_URL").unwrap_or_default();
        let base = if !cfg.ai_base_url.is_empty() { cfg.ai_base_url.clone() } else if !env_base.is_empty() { env_base } else { template.base_url.to_string() };
        (key, base, template)
    }

    async fn llm(&self, model: &str, system: &str, user_text: &str) -> Result<String, ApiError> {
        self.llm_max(model, system, user_text, 400).await
    }

    async fn llm_max(&self, model: &str, system: &str, user_text: &str, max_tokens: u32) -> Result<String, ApiError> {
        let (api_key, base, template) = self.ai_credentials();
        if api_key.is_empty() && !template.local {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "No API key configured — set one in AI Config"));
        }
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "No base URL configured for this provider — set one in AI Config"));
        }
        if model.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team"));
        }

        let client = reqwest::Client::new();
        let resp: reqwest::Response = if template.protocol == "anthropic" {
            client.post(format!("{base}/v1/messages"))
                .header("x-api-key", &api_key)
                .bearer_auth(&api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": model, "max_tokens": max_tokens, "system": system,
                    "messages": [{ "role": "user", "content": user_text }],
                }))
                .send().await
        } else {
            let url = if base.contains("/v1") { format!("{base}/chat/completions") } else { format!("{base}/v1/chat/completions") };
            client.post(url)
                .bearer_auth(&api_key)
                .json(&json!({
                    "model": model, "max_tokens": max_tokens,
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
        "model": p.model, "models": p.models, "key_hint": p.key_hint, "local": p.local, "note": p.note,
    })).collect::<Vec<_>>()))
}

async fn agent_status(State(app): State<App>) -> Json<Value> {
    let (key, base, template) = app.ai_credentials();
    Json(json!({
        "model": template.model,
        "provider": template.label,
        "provider_id": template.id,
        "base_url": base,
        "key_configured": !key.is_empty() || template.local,
    }))
}

/// Both protocol families answer model listings as {"data":[{"id": ...}]}
fn parse_model_list(v: &Value) -> Vec<String> {
    v.get("data").and_then(|d| d.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
            .map(String::from)
            .filter(|s| !s.is_empty())
            .collect()
    }).unwrap_or_default()
}

/// Models of the ACTIVE provider: live-fetched from its models endpoint, falling back
/// to the template's static preset list. Cached for 60s.
async fn list_models(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    let (api_key, base, template) = app.ai_credentials();
    let base = base.trim_end_matches('/').to_string();

    let cached = {
        let store = app.store.lock().unwrap();
        store.models_cache.as_ref().filter(|c|
            c.provider == template.id && c.base == base && now_secs().saturating_sub(c.fetched_at) < 60
        ).map(|c| (c.models.clone(), c.live))
    };
    let (models, live) = match cached {
        Some(hit) => hit,
        None => {
            // skip the live call when it cannot succeed: no base URL (unfilled custom),
            // or no key on a remote provider
            let can_try = !base.is_empty() && (!api_key.is_empty() || template.local);
            let fetched: Vec<String> = if !can_try { Vec::new() } else {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(6))
                    .build().unwrap_or_default();
                // try the standard models paths for the protocol in order — some
                // proxies only expose one of them (chat path mirrors llm_max())
                let urls: Vec<String> = if template.protocol == "anthropic" {
                    vec![format!("{base}/v1/models"), format!("{base}/models")]
                } else if base.contains("/v1") {
                    vec![format!("{base}/models")]
                } else {
                    vec![format!("{base}/v1/models"), format!("{base}/models")]
                };
                let mut fetched = Vec::new();
                for url in &urls {
                    let resp = if template.protocol == "anthropic" {
                        client.get(url.clone())
                            .header("x-api-key", &api_key)
                            .bearer_auth(&api_key)
                            .header("anthropic-version", "2023-06-01")
                            .send().await
                    } else {
                        client.get(url.clone()).bearer_auth(&api_key).send().await
                    };
                    if let Ok(r) = resp {
                        if r.status().is_success() {
                            if let Ok(v) = r.json::<Value>().await {
                                fetched = parse_model_list(&v);
                                if !fetched.is_empty() { break; }
                            }
                        }
                    }
                }
                fetched
            };
            let live = !fetched.is_empty();
            let models = if live { fetched } else { template.models.iter().map(|s| s.to_string()).collect() };
            app.store.lock().unwrap().models_cache = Some(ModelsCache {
                provider: template.id.into(), base, fetched_at: now_secs(), models: models.clone(), live,
            });
            (models, live)
        }
    };

    Ok(json_ok(json!({
        "models": models,
        "source": if live { "live" } else { "fallback" },
        "provider": template.label,
        "provider_id": template.id,
    })))
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
            binds: Some(vec![format!("{WORKSPACE_VOLUME}:/workspace")]),
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
// Interactive terminal — WebSocket ↔ Docker exec TTY bridge
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TerminalParams {
    token: Option<String>, // sessions can't travel in headers on a WS handshake
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn terminal_ws(
    State(app): State<App>,
    ws: WebSocketUpgrade,
    Path(ident): Path<String>,
    Query(params): Query<TerminalParams>,
) -> Response {
    if auth_enabled() {
        let token = params.token.clone().unwrap_or_default();
        let valid = app.store.lock().unwrap().sessions.contains_key(&token);
        if !valid {
            return (StatusCode::UNAUTHORIZED, "Login required").into_response();
        }
    }
    let managed = match app.inspect_managed(&ident).await {
        Ok(m) => m,
        Err(e) => return e.into_response(),
    };
    let status = App::status_of(&managed);
    if status != "running" {
        return (StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")).into_response();
    }
    let container_id = managed.id.unwrap_or_default();
    let initial = (params.cols.unwrap_or(80), params.rows.unwrap_or(24));
    ws.on_upgrade(move |socket| terminal_session(app, socket, container_id, initial))
}

/// Pick the best interactive shell available inside the container.
async fn pick_shell(app: &App, container_id: &str) -> &'static str {
    if let Ok((_, out)) = app.exec_in(container_id, "command -v bash").await {
        if out.trim().contains("bash") {
            return "/bin/bash";
        }
    }
    "/bin/sh"
}

/// Bridge a browser terminal to a real PTY-backed shell via `docker exec`.
/// Binary frames carry terminal bytes both ways; text frames are control
/// messages (`{"resize":{"cols":n,"rows":r}}`).
async fn terminal_session(app: App, socket: WebSocket, container_id: String, (cols, rows): (u16, u16)) {
    let mut socket = socket;
    let docker = match app.docker() {
        Ok(d) => d.clone(),
        Err(e) => {
            let _ = socket.send(Message::Text(format!("docker unavailable: {}\r\n", e.1).into())).await;
            return;
        }
    };

    let shell = pick_shell(&app, &container_id).await;
    let exec = match docker.create_exec(&container_id, CreateExecOptions::<&str> {
        cmd: Some(vec![shell, "-l"]),
        attach_stdin: Some(true),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        tty: Some(true),
        env: Some(vec!["TERM=xterm-256color"]),
        ..Default::default()
    }).await {
        Ok(e) => e,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("failed to start shell: {e}\r\n").into())).await;
            return;
        }
    };

    let (mut input, output) = match docker.start_exec(&exec.id, None).await {
        Ok(StartExecResults::Attached { input, output }) => (input, output),
        Ok(_) => {
            let _ = socket.send(Message::Text("shell detached unexpectedly\r\n".into())).await;
            return;
        }
        Err(e) => {
            let _ = socket.send(Message::Text(format!("failed to attach shell: {e}\r\n").into())).await;
            return;
        }
    };

    // Match the PTY to the browser terminal size before the first prompt renders
    let _ = docker.resize_exec(&exec.id, ResizeExecOptions { width: cols, height: rows }).await;

    let (mut ws_tx, mut ws_rx) = socket.split();
    let exec_id = exec.id.clone();

    // Container → browser
    let pump = tokio::spawn(async move {
        let mut output = output;
        while let Some(Ok(frame)) = output.next().await {
            if ws_tx.send(Message::Binary(frame.into_bytes().into())).await.is_err() {
                break;
            }
        }
        // Shell exited — close the socket so the UI can offer reconnect
        let _ = ws_tx.send(Message::Close(None)).await;
    });

    // Browser → container
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Binary(data) => {
                if input.write_all(&data).await.is_err() {
                    break;
                }
                let _ = input.flush().await;
            }
            Message::Text(txt) => {
                if let Some(sz) = serde_json::from_str::<Value>(txt.as_str()).ok().and_then(|v| v.get("resize").cloned()) {
                    let c = sz.get("cols").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
                    let r = sz.get("rows").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
                    let _ = docker.resize_exec(&exec_id, ResizeExecOptions { width: c, height: r }).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    pump.abort();
    let _ = input.shutdown().await;
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

    // Disk size of the container's root fs — `df` runs INSIDE so overlays/volumes
    // report what the agent actually sees. Best-effort: null when exec fails (stopped).
    let (disk_used, disk_total) = match app.exec_in(&id, "df -P / | tail -1").await {
        Ok((0, out)) => {
            let f: Vec<&str> = out.split_whitespace().collect();
            match (f.get(1).and_then(|s| s.parse::<u64>().ok()), f.get(2).and_then(|s| s.parse::<u64>().ok())) {
                // df -P reports 1K blocks
                (Some(total_kb), Some(used_kb)) => (json!(used_kb * 1024), json!(total_kb * 1024)),
                _ => (Value::Null, Value::Null),
            }
        }
        _ => (Value::Null, Value::Null),
    };

    Ok(json_ok(json!({
        "cpu_percent": (cpu_percent * 100.0).round() / 100.0,
        "mem_used": mem_used,
        "mem_limit": mem_limit,
        "net_rx": net_rx,
        "net_tx": net_tx,
        "disk_used": disk_used,
        "disk_total": disk_total,
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
// Handlers — connectors (Grok-style per-container integrations)
//
// GitHub connector: each container logs in with its OWN GitHub account via the
// device flow (browser auth, one per machine). The platform brokers the flow
// but never stores tokens — gh's credentials live inside the container only,
// and status is derived by probing the container itself.
// ---------------------------------------------------------------------------

/// Static catalog of available connectors. Each connector lists the auth
/// methods it supports (device = browser device flow, token = paste a
/// personal access token); the UI renders one flow per method.
async fn connectors_catalog() -> ApiResult {
    Ok(json_ok(json!([
        {
            "type": "github",
            "name": "GitHub",
            "description": "gh CLI + git push/pull ใน container — ใช้ private repo, issue และ PR ได้จากในเครื่องนั้นโดยตรง (login แยกทีละเครื่อง)",
            "auth_methods": [
                { "id": "device", "name": "Browser (device flow)" },
                { "id": "token", "name": "Personal access token" },
            ],
        },
        {
            "type": "figma",
            "name": "Figma",
            "description": "Figma REST API ใน container — agent อ่าน design file, ดึง component และ export รูปจากในเครื่องนั้นได้ (token อยู่ที่ ~/.config/figma/token)",
            "auth_methods": [
                { "id": "token", "name": "Personal access token" },
            ],
        },
    ])))
}

/// Body for token-based connector auth: { "token": "ghp_…" / "figd_…" }
#[derive(serde::Deserialize)]
struct TokenAuthBody {
    token: String,
}

/// `✓ Logged in to github.com account <login> (keyring)` → login
fn parse_gh_login(output: &str) -> Option<String> {
    output.split("account ").nth(1)?
        .split_whitespace().next()
        .map(|s| s.trim_matches(|c| c == '(' || c == ')').to_string())
        .filter(|s| !s.is_empty())
}

/// Probe a container's GitHub connector state via exec, cached for
/// CONNECTOR_CACHE_TTL so the UI's 5s polls don't exec every container
/// constantly. States: connected (+login) / disconnected / unavailable
/// (no gh binary in the image, or container not running).
async fn github_connector_status(app: &App, inspect: &bollard::models::ContainerInspectResponse) -> CachedConnectorStatus {
    let container_id = inspect.id.clone().unwrap_or_default();
    if App::status_of(inspect) != "running" {
        return CachedConnectorStatus { state: "unavailable".into(), login: None, reason: Some("container not running".into()), at: now_secs() };
    }
    let cache_key = format!("{container_id}:github");
    {
        let store = app.store.lock().unwrap();
        if let Some(c) = store.connector_cache.get(&cache_key) {
            if now_secs().saturating_sub(c.at) < CONNECTOR_CACHE_TTL {
                return c.clone();
            }
        }
    }
    // One round trip: 127 = no gh binary; 0 = logged in (parse the account);
    // anything else = gh present but not logged in. Note: no GH_TOKEN-style env
    // must ever ride this exec — it would mask the stored credential.
    let (code, output) = match app.exec_in(&container_id, "command -v gh >/dev/null 2>&1 || exit 127; gh auth status --hostname github.com").await {
        Ok(r) => r,
        Err(_) => (127, String::new()),
    };
    let status = if code == 127 {
        CachedConnectorStatus { state: "unavailable".into(), login: None, reason: Some("no gh CLI in this image — use the agent-base image".into()), at: now_secs() }
    } else if code == 0 {
        CachedConnectorStatus { state: "connected".into(), login: parse_gh_login(&output), reason: None, at: now_secs() }
    } else {
        CachedConnectorStatus { state: "disconnected".into(), login: None, reason: None, at: now_secs() }
    };
    app.store.lock().unwrap().connector_cache.insert(cache_key, status.clone());
    status
}

/// Probe a container's Figma connector state. Figma has no CLI whose login we
/// could ask about — the token file in the container's home IS the credential
/// store, so the probe is a single file check (plus the handle written next to
/// it at connect time). It works on any image, so "unavailable" here only
/// means the container itself is not running.
async fn figma_connector_status(app: &App, inspect: &bollard::models::ContainerInspectResponse) -> CachedConnectorStatus {
    let container_id = inspect.id.clone().unwrap_or_default();
    if App::status_of(inspect) != "running" {
        return CachedConnectorStatus { state: "unavailable".into(), login: None, reason: Some("container not running".into()), at: now_secs() };
    }
    let cache_key = format!("{container_id}:figma");
    {
        let store = app.store.lock().unwrap();
        if let Some(c) = store.connector_cache.get(&cache_key) {
            if now_secs().saturating_sub(c.at) < CONNECTOR_CACHE_TTL {
                return c.clone();
            }
        }
    }
    // 0 = token file present (stdout = saved handle); anything else = not
    // connected. A docker/exec failure also lands in "disconnected" — the
    // container is the source of truth and the next poll re-derives it.
    let (code, output) = match app.exec_in(&container_id,
        r#"[ -f "$HOME/.config/figma/token" ] || exit 1; cat "$HOME/.config/figma/user" 2>/dev/null"#,
    ).await {
        Ok(r) => r,
        Err(_) => (1, String::new()),
    };
    let status = if code == 0 {
        let login = output.trim().split_whitespace().next().map(|s| s.to_string()).filter(|s| !s.is_empty());
        CachedConnectorStatus { state: "connected".into(), login, reason: None, at: now_secs() }
    } else {
        CachedConnectorStatus { state: "disconnected".into(), login: None, reason: None, at: now_secs() }
    };
    app.store.lock().unwrap().connector_cache.insert(cache_key, status.clone());
    status
}

fn connector_json(ctype: &str, status: &CachedConnectorStatus) -> Value {
    json!({
        "type": ctype,
        "state": status.state,
        "login": status.login,
        "reason": status.reason,
    })
}

/// Current GitHub connector state for one container. An active device flow
/// wins over the probe so a refreshed dialog can resume with its user code.
async fn github_state_json(app: &App, inspect: &bollard::models::ContainerInspectResponse) -> Value {
    let container_id = inspect.id.clone().unwrap_or_default();
    let pending = {
        let store = app.store.lock().unwrap();
        store.pending_device_flows.get(&container_id)
            .filter(|f| f.expires_at > now_secs())
            .map(|f| json!({
                "type": "github", "state": "pending", "login": null, "reason": null,
                "user_code": f.user_code, "verification_url": f.verification_url,
            }))
    };
    match pending {
        Some(v) => v,
        None => connector_json("github", &github_connector_status(app, inspect).await),
    }
}

/// GET /containers/{ident}/connectors — per-connector state for one container.
async fn container_connectors(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let inspect = app.inspect(&ident).await?;
    Ok(json_ok(json!([
        github_state_json(&app, &inspect).await,
        connector_json("figma", &figma_connector_status(&app, &inspect).await),
    ])))
}

/// GET /connectors/status — every managed container × its connector states,
/// for the connectors overview page.
async fn connectors_status(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    let mut filters = HashMap::new();
    filters.insert("label".to_string(), vec![format!("{}={}", MANAGED_LABEL, MANAGED_VALUE)]);
    let opts = ListContainersOptionsBuilder::new().all(true).filters(&filters).build();
    let list = app.docker()?
        .list_containers(Some(opts))
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;

    let mut rows = Vec::new();
    for c in list {
        let id = c.id.clone().unwrap_or_default();
        let state = c.state.as_ref().map(|s| s.to_string()).unwrap_or_else(|| "unknown".into());
        let (github, figma) = if state != "running" {
            (
                json!({ "type": "github", "state": "unavailable", "login": null, "reason": "container not running" }),
                json!({ "type": "figma", "state": "unavailable", "login": null, "reason": "container not running" }),
            )
        } else {
            match app.inspect(&id).await {
                Ok(inspect) => (
                    github_state_json(&app, &inspect).await,
                    connector_json("figma", &figma_connector_status(&app, &inspect).await),
                ),
                Err(_) => (
                    json!({ "type": "github", "state": "unavailable", "login": null, "reason": "inspect failed" }),
                    json!({ "type": "figma", "state": "unavailable", "login": null, "reason": "inspect failed" }),
                ),
            }
        };
        rows.push(json!({
            "id": id.chars().take(12).collect::<String>(),
            "name": c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default(),
            "status": state,
            "image": c.image.clone().unwrap_or_default(),
            "role": c.labels.as_ref().and_then(|l| l.get("role").cloned()).unwrap_or_default(),
            "connectors": [github, figma],
        }));
    }
    Ok(json_ok(Value::Array(rows)))
}

/// POST /containers/{ident}/connectors/github/connect — start (or resume) the
/// device flow. Responds with the user code + verification URL; the token,
/// once the user approves, is injected by the spawned poll task.
async fn github_connect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let container_id = managed.id.clone().unwrap_or_default();

    // gh binary present? (agent-base ships it; bare alpine does not)
    let (gh_ok, _) = app.exec_in(&container_id, "command -v gh >/dev/null 2>&1").await?;
    if gh_ok != 0 {
        return Err(err(StatusCode::BAD_REQUEST, "gh CLI not found in this container — create it from the agent-base image to connect GitHub"));
    }

    // Idempotent: an unexpired pending flow returns its code so a re-opened
    // dialog resumes instead of minting a second flow
    let existing = {
        let store = app.store.lock().unwrap();
        store.pending_device_flows.get(&container_id)
            .filter(|f| f.expires_at > now_secs())
            .map(|f| (f.user_code.clone(), f.verification_url.clone(), f.expires_at.saturating_sub(now_secs())))
    };
    if let Some((user_code, verification_url, expires_in)) = existing {
        return Ok(json_ok(json!({ "user_code": user_code, "verification_url": verification_url, "expires_in": expires_in })));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap_or_default();
    let resp = client.post("https://github.com/login/device/code")
        .header("User-Agent", "ai-agent-platform")
        .header("Accept", "application/json")
        .form(&[("client_id", GH_DEVICE_CLIENT_ID), ("scope", GH_DEVICE_SCOPE)])
        .send().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("GitHub device flow unavailable: {e}")))?;
    if !resp.status().is_success() {
        return Err(err(StatusCode::BAD_GATEWAY, format!("GitHub rejected the device request (HTTP {})", resp.status())));
    }
    let body: Value = resp.json().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Bad device-code response: {e}")))?;
    let device_code = body["device_code"].as_str().unwrap_or_default().to_string();
    let user_code = body["user_code"].as_str().unwrap_or_default().to_string();
    let verification_url = body["verification_uri"].as_str()
        .or_else(|| body["verification_url"].as_str())
        .unwrap_or("https://github.com/login/device").to_string();
    let interval = body["interval"].as_u64().unwrap_or(5).max(1);
    let expires_in = body["expires_in"].as_u64().unwrap_or(900);
    if device_code.is_empty() || user_code.is_empty() {
        return Err(err(StatusCode::BAD_GATEWAY, "GitHub device response missing codes"));
    }

    {
        let mut store = app.store.lock().unwrap();
        store.pending_device_flows.insert(container_id.clone(), PendingDeviceFlow {
            device_code,
            user_code: user_code.clone(),
            verification_url: verification_url.clone(),
            interval,
            expires_at: now_secs() + expires_in,
        });
        // a fresh flow must not be masked by a stale "disconnected" probe
        store.connector_cache.remove(format!("{container_id}:github").as_str());
    }

    let poll_app = app.clone();
    let poll_id = container_id.clone();
    tokio::spawn(async move { poll_github_device_flow(poll_app, poll_id).await });

    Ok(json_ok(json!({ "user_code": user_code, "verification_url": verification_url, "expires_in": expires_in })))
}

/// Validate a GitHub token against the API, derive the git commit identity
/// from the account's own profile, then inject gh credentials into the
/// container. Shared by the device-flow poll task and the paste-a-token
/// endpoint — the token exists only on this call's stack, never in Store,
/// logs, or API responses. Returns the account login on success.
async fn inject_github_token(app: &App, container_id: &str, token: &str) -> Result<String, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap_or_default();
    let resp = client.get("https://api.github.com/user")
        .header("User-Agent", "ai-agent-platform")
        .bearer_auth(token)
        .send().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("GitHub API unreachable: {e}")))?;
    if !resp.status().is_success() {
        return Err(err(StatusCode::UNAUTHORIZED, format!("GitHub rejected this token (HTTP {}) — ตรวจ token หรือ scope อีกครั้ง", resp.status())));
    }
    let u: Value = resp.json().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Bad GitHub profile response: {e}")))?;
    let login = u["login"].as_str().unwrap_or("github-user").to_string();
    let name = u["name"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let email = u["email"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let user_name = name.unwrap_or_else(|| login.clone());
    let user_email = email.unwrap_or_else(|| format!("{login}@users.noreply.github.com"));

    // Inject credentials via exec ENV — the token never shows up in `ps`
    // output or shell history. GH_LOGIN_TOKEN, not GH_TOKEN: gh special-cases
    // GH_TOKEN and would refuse `login --with-token` / mask stored creds.
    let login_script = r#"printf %s "$GH_LOGIN_TOKEN" | gh auth login --with-token --hostname github.com && gh auth setup-git && git config --global user.name "$GIT_USER_NAME" && git config --global user.email "$GIT_USER_EMAIL""#;
    let (code, _) = app.exec_in_env(container_id, login_script, vec![
        format!("GH_LOGIN_TOKEN={token}"),
        format!("GIT_USER_NAME={user_name}"),
        format!("GIT_USER_EMAIL={user_email}"),
    ]).await?;

    let cache_key = format!("{container_id}:github");
    let mut store = app.store.lock().unwrap();
    if code == 0 {
        store.connector_cache.insert(cache_key, CachedConnectorStatus {
            state: "connected".into(),
            login: Some(login.clone()),
            reason: None,
            at: now_secs(),
        });
        Ok(login)
    } else {
        // container stopped/deleted mid-flow — the next probe re-derives reality
        store.connector_cache.remove(cache_key.as_str());
        Err(err(StatusCode::BAD_GATEWAY, "Failed to inject credentials into the container"))
    }
}

/// Background half of the device flow: poll GitHub until the user approves (or
/// the code expires), then inject gh credentials into the container. The token
/// exists only on this task's stack — never in Store, logs, or API responses.
async fn poll_github_device_flow(app: App, container_id: String) {
    let (device_code, mut interval, expires_at) = {
        let store = app.store.lock().unwrap();
        match store.pending_device_flows.get(&container_id) {
            Some(f) => (f.device_code.clone(), f.interval, f.expires_at),
            None => return,
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().unwrap_or_default();

    loop {
        if now_secs() >= expires_at {
            app.store.lock().unwrap().pending_device_flows.remove(&container_id);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;

        let resp = match client.post("https://github.com/login/oauth/access_token")
            .header("User-Agent", "ai-agent-platform")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", GH_DEVICE_CLIENT_ID),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send().await
        {
            Ok(r) => r,
            Err(_) => continue, // transient network error — retry next tick
        };
        let Ok(body) = resp.json::<Value>().await else { continue };
        match body["error"].as_str().unwrap_or("") {
            "authorization_pending" => continue,
            "slow_down" => { interval += 5; continue; }
            "expired_token" | "unsupported_grant_type" | "access_denied" => {
                app.store.lock().unwrap().pending_device_flows.remove(&container_id);
                return;
            }
            _ => {}
        }
        let token = body["access_token"].as_str().unwrap_or("").to_string();
        if token.is_empty() { continue; }

        // Disconnect (or a replacement flow) may have cancelled this one while
        // GitHub held the code — only inject when THIS flow is still active.
        let still_active = {
            let store = app.store.lock().unwrap();
            store.pending_device_flows.get(&container_id)
                .map(|f| f.device_code == device_code)
                .unwrap_or(false)
        };
        if !still_active { return; }

        // Fresh from GitHub, so validation here is near-certain to pass; on
        // any failure just drop the flow — the probe re-derives reality.
        let _ = inject_github_token(&app, &container_id, &token).await;
        app.store.lock().unwrap().pending_device_flows.remove(&container_id);
        return;
    }
}

/// POST /containers/{ident}/connectors/github/disconnect — remove gh
/// credentials from the container (best-effort, from inside the box).
async fn github_disconnect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let container_id = managed.id.clone().unwrap_or_default();
    // `gh auth logout` prompts for confirmation and aborts without a TTY —
    // pipe "y" AND remove the credential file directly so the logout is real
    // either way. Best-effort: the trailing `true` makes the exit code 0.
    let (_, output) = app.exec_in(&container_id,
        r#"printf 'y\n' | gh auth logout --hostname github.com 2>/dev/null; rm -f "$HOME/.config/gh/hosts.yml"; git config --global --unset credential.https://github.com.helper 2>/dev/null; true"#
    ).await?;
    {
        let mut store = app.store.lock().unwrap();
        // also drop any in-flight device flow: approving its code after a
        // disconnect must NOT silently re-login the container
        store.pending_device_flows.remove(&container_id);
        store.connector_cache.remove(format!("{container_id}:github").as_str());
    }
    Ok(json_ok(json!({ "type": "github", "state": "disconnected", "output": output })))
}

/// POST /containers/{ident}/connectors/github/connect-token — auth method #2:
/// paste a personal access token instead of the browser device flow. The token
/// is validated against the GitHub API first (so typos surface here, not as a
/// broken `gh` inside the box), then takes the exact same injection path the
/// device flow uses. Works with classic and fine-grained PATs; repo scope is
/// what git push needs.
async fn github_connect_token(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, axum::Json(body): axum::Json<TokenAuthBody>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let container_id = managed.id.clone().unwrap_or_default();
    let (gh_ok, _) = app.exec_in(&container_id, "command -v gh >/dev/null 2>&1").await?;
    if gh_ok != 0 {
        return Err(err(StatusCode::BAD_REQUEST, "gh CLI not found in this container — create it from the agent-base image to connect GitHub"));
    }
    let token = body.token.trim();
    if token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Token is required"));
    }
    let login = inject_github_token(&app, &container_id, token).await?;
    Ok(json_ok(json!({ "type": "github", "state": "connected", "login": login })))
}

/// POST /containers/{ident}/connectors/figma/connect-token — Figma only has
/// one auth method here: a personal access token (Figma account → Settings →
/// Security → Personal access tokens). Validated against /v1/me, then written
/// into the container as ~/.config/figma/token (+ FIGMA_TOKEN exported in the
/// shell profiles) so any shell or agent in the box can call the REST API.
/// The token rides the exec ENV — never the command string, Store, or logs.
async fn figma_connect_token(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, axum::Json(body): axum::Json<TokenAuthBody>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let container_id = managed.id.clone().unwrap_or_default();
    let token = body.token.trim();
    if token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Token is required"));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap_or_default();
    let resp = client.get("https://api.figma.com/v1/me")
        .header("X-Figma-Token", token)
        .send().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Figma API unreachable: {e}")))?;
    if !resp.status().is_success() {
        return Err(err(StatusCode::UNAUTHORIZED, format!("Figma rejected this token (HTTP {}) — สร้างใหม่ได้ที่ Settings → Security → Personal access tokens", resp.status())));
    }
    let me: Value = resp.json().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Bad Figma profile response: {e}")))?;
    let handle = me["handle"].as_str().map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| me["email"].as_str().map(|s| s.trim().to_string()))
        .unwrap_or_else(|| "figma-user".into());

    // Write token + handle into ~/.config/figma, and export FIGMA_TOKEN from
    // the token file in both shell profiles (idempotent — one line max).
    let script = r#"mkdir -p "$HOME/.config/figma" && printf %s "$FIGMA_AUTH_TOKEN" > "$HOME/.config/figma/token" && printf %s "$FIGMA_AUTH_USER" > "$HOME/.config/figma/user" && line='export FIGMA_TOKEN="$(cat "$HOME/.config/figma/token" 2>/dev/null)"' && { grep -q 'FIGMA_TOKEN' "$HOME/.profile" 2>/dev/null || echo "$line" >> "$HOME/.profile"; } && { grep -q 'FIGMA_TOKEN' "$HOME/.bashrc" 2>/dev/null || echo "$line" >> "$HOME/.bashrc"; }"#;
    let (code, _) = app.exec_in_env(&container_id, script, vec![
        format!("FIGMA_AUTH_TOKEN={token}"),
        format!("FIGMA_AUTH_USER={handle}"),
    ]).await?;

    let cache_key = format!("{container_id}:figma");
    let mut store = app.store.lock().unwrap();
    if code == 0 {
        store.connector_cache.insert(cache_key, CachedConnectorStatus {
            state: "connected".into(),
            login: Some(handle.clone()),
            reason: None,
            at: now_secs(),
        });
        Ok(json_ok(json!({ "type": "figma", "state": "connected", "login": handle })))
    } else {
        store.connector_cache.remove(cache_key.as_str());
        Err(err(StatusCode::BAD_GATEWAY, "Failed to write the token into the container"))
    }
}

/// POST /containers/{ident}/connectors/figma/disconnect — remove the token
/// files and the profile exports from the container (best-effort).
async fn figma_disconnect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let container_id = managed.id.clone().unwrap_or_default();
    let (_, output) = app.exec_in(&container_id,
        r#"rm -rf "$HOME/.config/figma"; sed -i '/FIGMA_TOKEN/d' "$HOME/.profile" "$HOME/.bashrc" 2>/dev/null; true"#
    ).await?;
    app.store.lock().unwrap().connector_cache.remove(format!("{container_id}:figma").as_str());
    Ok(json_ok(json!({ "type": "figma", "state": "disconnected", "output": output })))
}

/// POST /containers/{ident}/connectors/github/open-browser — open the device
/// verification URL in the container's own desktop browser (agent-base runs
/// Xvnc on :1), so the login happens "on that machine" like the user wants.
async fn github_open_browser(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let managed = app.inspect_managed(&ident).await?;
    let status = App::status_of(&managed);
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Container is not running (status: {status})")));
    }
    let container_id = managed.id.clone().unwrap_or_default();
    // URL comes from the stored pending flow — never from client input
    let url = {
        let store = app.store.lock().unwrap();
        store.pending_device_flows.get(&container_id)
            .filter(|f| f.expires_at > now_secs())
            .map(|f| f.verification_url.clone())
    };
    let Some(url) = url else {
        return Err(err(StatusCode::BAD_REQUEST, "No active GitHub login flow — click Connect first"));
    };
    // chromium as root needs --no-sandbox; launched detached (&) so the exec
    // returns immediately instead of waiting for the browser to exit.
    let script = format!(
        r#"command -v chromium >/dev/null 2>&1 || exit 127; (chromium --no-sandbox --disable-dev-shm-usage '{url}' >/dev/null 2>&1 &)"#
    );
    let (code, _) = app.exec_in_env(&container_id, &script, vec!["DISPLAY=:1".to_string()]).await?;
    if code != 0 {
        return Err(err(StatusCode::BAD_REQUEST, "No chromium browser in this container — open the URL on any browser instead"));
    }
    Ok(json_ok(json!({ "opened": true, "url": url })))
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
    let base_prompt = persona.as_ref().map(|p| p.rules_md.clone())
        .unwrap_or_else(|| "You are a capable autonomous Linux agent.".into());
    let model = match app.model_for_persona(persona.as_ref()) {
        Some(m) => m,
        None => return Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
    };

    if req.consult {
        let system = format!(
            "{base_prompt}\n\nAnswer the user in the user's language. Be concise, concrete and senior — like a veteran giving advice to a colleague. Use short markdown lists where helpful. Do NOT invent facts."
        );
        let reply = app.llm(&model, &system, &req.command).await?;
        return Ok(json_ok(json!({ "mode": "consult", "role": role_label, "model": model, "reply": reply })));
    }

    // Bot-on-a-Linux-box rule: every command runs inside this container, and
    // the project repo is cloned into /workspace BEFORE any work — then all
    // file/code work goes through that repo working tree only. First the
    // default tool belt is ensured and probed, so the model is told what this
    // box really has (and what it does NOT) instead of guessing.
    let container_id = managed.id.clone().unwrap_or_default();
    app.ensure_tools(&container_id).await;
    let tools_md = app.tools_manifest(&container_id).await.unwrap_or_default();
    let repo_url = app.repo_for_role(&role_label);
    let (repo_path, repo_warning) = if repo_url.is_empty() {
        (None, None)
    } else {
        match app.ensure_repo(&container_id, &repo_url).await {
            Ok(path) => (Some(path), None),
            // one clone failure must not brick commands that don't touch the repo
            Err(e) => (None, Some(e.1)),
        }
    };

    let repo_rules = match &repo_path {
        Some(p) => format!(
            " The project repository is already cloned in this container at {p} — it is your working directory. Run ALL file and code work through that repo working tree ONLY (never clone, copy or recreate it elsewhere)."
        ),
        None => String::new(),
    };
    let system = format!(
        "{base_prompt}\n\nYou are operating inside a Linux container (Ubuntu/Alpine, sh shell) as an autonomous agent. The user gives a request in any language. Answer with EXACTLY ONE line containing ONE safe sh command that accomplishes the request using your expertise. Output the bare command only — no markdown, no backticks, no explanation. If the request is a question, answer it with a command that prints the answer (e.g. echo).{tools_md}{repo_rules}"
    );
    let reply = app.llm(&model, &system, &req.command).await?;
    let command = reply.trim().trim_matches('`').lines().last().unwrap_or("").trim().to_string();
    if command.is_empty() {
        return Err(err(StatusCode::BAD_GATEWAY, format!("Model returned no usable command: {reply:?}")));
    }
    // run from the repo working tree so relative paths land inside the repo
    let exec_command = match &repo_path {
        Some(p) => format!("cd '{p}' 2>/dev/null; {command}"),
        None => command.clone(),
    };
    let (exit_code, output) = app.exec_in(&container_id, &exec_command).await?;
    Ok(json_ok(json!({
        "mode": "execute", "role": role_label, "model": model, "reply": reply,
        "command": command, "exit_code": exit_code, "output": output,
        "repo": repo_path, "repo_warning": repo_warning,
    })))
}

// ---------------------------------------------------------------------------
// Handlers — personas (AI team, editable via UI with markdown rules)
// ---------------------------------------------------------------------------

async fn list_agents(State(app): State<App>) -> ApiResult {
    let (personas, provider_id, default_model) = {
        let store = app.store.lock().unwrap();
        let pid = store.config.ai_provider.clone();
        let dm = provider_template(&pid).unwrap_or(&PROVIDERS[0]).model.to_string();
        (store.personas.clone(), pid, dm)
    };
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

    let agents: Vec<Value> = personas.iter().map(|p| {
        // effective model for the CURRENT active provider ("" = unconfigured)
        let model = p.model_overrides.get(&provider_id)
            .filter(|m| !m.is_empty()).cloned()
            .unwrap_or_else(|| default_model.clone());
        json!({
            "role": p.role, "name": p.name, "title": p.title, "years": p.years,
            "expertise": p.expertise, "rules_md": p.rules_md,
            "model": model, "model_overrides": p.model_overrides,
            "container": running.get(&p.role),
        })
    }).collect();
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
    let provider_id = store.config.ai_provider.clone();
    let p = store.personas.iter_mut().find(|p| p.role == role)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Persona '{role}' not found")))?;
    if let Some(v) = req.name { if !v.is_empty() { p.name = v; } }
    if let Some(v) = req.title { p.title = v; }
    if let Some(v) = req.years { p.years = v; }
    if let Some(v) = req.expertise { p.expertise = v; }
    if let Some(v) = req.rules_md { p.rules_md = v; }
    if let Some(v) = req.model {
        // unlike the other fields, an empty string here MEANS "clear the override"
        let v = v.trim().to_string();
        if v.is_empty() { p.model_overrides.remove(&provider_id); }
        else { p.model_overrides.insert(provider_id, v); }
    }
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
        "default_image": cfg.default_image,
        "max_containers": cfg.max_containers,
        "auto_restart": cfg.auto_restart,
        "ai_provider": cfg.ai_provider,
        "ai_base_url": cfg.ai_base_url,
        "ai_api_key_masked": masked,
        "git_token_set": !cfg.git_token.is_empty(),
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
        if let Some(v) = req.default_image.clone() { if !v.is_empty() { cfg.default_image = v; } }
        if let Some(v) = req.max_containers { cfg.max_containers = v; }
        if let Some(v) = req.auto_restart { cfg.auto_restart = v; }
        if let Some(v) = req.ai_provider { cfg.ai_provider = v; }
        if let Some(v) = req.ai_base_url { cfg.ai_base_url = v; }
        if let Some(v) = req.ai_api_key { if !v.is_empty() { cfg.ai_api_key = v; } }
        if let Some(v) = req.git_token { if !v.is_empty() { cfg.git_token = v.trim().to_string(); } }
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
        repo_url: req.repo_url.trim().trim_end_matches(".git").to_string(),
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
    if let Some(v) = req.repo_url { p.repo_url = v.trim().trim_end_matches(".git").to_string(); }
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
    // Runs of the deleted project are KEPT — they are the agents' work history
    // (agent detail shows them across projects, and /data/runs.json persists them).
    Ok(json_ok(json!({ "deleted": id })))
}

// ---------------------------------------------------------------------------
// Handlers — team runs (dispatch one task through the project team)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RunRequest {
    task: String,
    /// loop mode — when the run finishes, the PO evaluates and the next
    /// iteration is spawned automatically (until DONE / stop / the cap)
    #[serde(default, rename = "loop")]
    run_loop: bool,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Run persistence — runs survive orchestrator restarts as /data/runs.json
// (agent-data volume in compose; env DATA_DIR overrides, ./data as local fallback)
// ---------------------------------------------------------------------------

fn data_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("DATA_DIR") {
        if !d.trim().is_empty() { return std::path::PathBuf::from(d); }
    }
    let preferred = std::path::Path::new("/data");
    if preferred.is_dir() { preferred.to_path_buf() } else { std::path::PathBuf::from("./data") }
}

fn runs_file() -> std::path::PathBuf {
    data_dir().join("runs.json")
}

/// Atomic whole-file save of the run history (tmp + rename — a crash never
/// leaves a half-written file). Called after every run mutation.
fn save_runs(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> {
        runs: &'a [Run],
        run_counter: usize,
    }
    let payload = match serde_json::to_string_pretty(&Persisted { runs: &store.runs, run_counter: store.run_counter }) {
        Ok(p) => p,
        Err(_) => return,
    };
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = runs_file();
    let tmp = dir.join("runs.json.tmp");
    // Best effort: platform keeps working in memory even when the disk write fails.
    if std::fs::write(&tmp, payload).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        eprintln!("warning: could not persist runs to {}", path.display());
    }
}

/// Restore the run history at boot. Runs that died mid-flight with the old
/// process (running / waiting_human) are closed as "stopped" — the engine task
/// is gone, so nobody would ever move them forward again.
fn load_runs(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted {
        #[serde(default)]
        runs: Vec<Run>,
        #[serde(default)]
        run_counter: usize,
    }
    let Ok(raw) = std::fs::read_to_string(runs_file()) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: {} is unreadable — starting with an empty run history", runs_file().display());
        return;
    };
    let mut runs = parsed.runs;
    let now = now_secs();
    for run in runs.iter_mut() {
        if run.status == "running" || run.status == "waiting_human" {
            run.status = "stopped".into();
            run.phase = "done".into();
            for d in run.discussions.iter_mut().filter(|d| d.status != "resolved") {
                d.status = "resolved".into();
                d.answering = None;
                d.messages.push(MeetingMessage {
                    from: "orchestrator".into(),
                    text: "the orchestrator restarted while this meeting was live — the run was closed; reply here is kept as a record".into(),
                    at: now,
                });
            }
        }
        run.stop_requested = false;
    }
    let max_id = runs.iter()
        .filter_map(|r| r.id.strip_prefix("run-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.run_counter = store.run_counter.max(parsed.run_counter).max(max_id);
    println!("restored {} run(s) from {}", runs.len(), runs_file().display());
    store.runs = runs;
}

/// Directory name for a cloned repo URL: last path segment, ".git" stripped,
/// sanitized to safe filename chars ("repo" when nothing usable remains).
fn repo_dir_name(repo_url: &str) -> String {
    let last = repo_url.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let cleaned: String = last.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches(['-', '.']).to_string();
    if cleaned.is_empty() { "repo".into() } else { cleaned }
}

/// Write a text deliverable into the agent's container workspace via a quoted heredoc.
async fn write_deliverable(app: &App, container_id: &str, run_id: &str, role: &str, output: &str) -> Result<String, ApiError> {
    let clean = output.replace('\r', "");
    let path = format!("/workspace/{run_id}-{role}.md");
    let script = format!(
        "mkdir -p /workspace && cat > '{path}' << 'AAP_EOF_9Z'\n{clean}\nAAP_EOF_9Z\n",
    );
    let (exit_code, out) = app.exec_in(container_id, &script).await?;
    if exit_code != 0 {
        return Err(err(StatusCode::BAD_GATEWAY, format!("writing deliverable failed (exit {exit_code}): {out}")));
    }
    Ok(path)
}

/// Meeting loop bound — after this many meeting rounds, still-open questions are
/// escalated to the human (need-human) and then closed; the PO decides in the summary.
const MAX_MEETING_ROUNDS: u32 = 2;

/// Loop mode bound — a loop chain spawns at most this many iterations.
const MAX_LOOP_ITERATIONS: u32 = 8;

/// How long a need-human wait holds the run before the team proceeds with a note.
const HUMAN_TIMEOUT_SECS: u64 = 3600;

/// Host ports for the isolated staging compose project the deploy stage spins
/// up — never the live 3000/8000, so a deploy can never restart the platform
/// that is running the mission itself.
const STAGING_WEB_PORT: &str = "13000";
const STAGING_API_PORT: &str = "18000";

/// Find a trailing "## ASK" block → (line index of the heading, addressed roles, question text).
fn find_ask(output: &str) -> Option<(usize, Vec<String>, String)> {
    let lines: Vec<&str> = output.lines().collect();
    let start = lines.iter().position(|l| {
        let t = l.trim().trim_start_matches('#').trim().to_lowercase();
        t == "ask" || t == "❓ ask"
    })?;
    let mut to: Vec<String> = Vec::new();
    let mut topic: Vec<&str> = Vec::new();
    for l in &lines[start + 1..] {
        if let Some((k, v)) = l.split_once(':') {
            let k = k.trim().to_lowercase();
            if (k == "to" || k == "ถึง") && to.is_empty() {
                to = v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
                continue;
            }
        }
        // a new heading after the question text ends the block
        if l.trim_start().starts_with('#') && !topic.iter().all(|t| t.trim().is_empty()) { break; }
        topic.push(l);
    }
    let topic = topic.join("\n").trim().to_string();
    if to.is_empty() || topic.is_empty() { None } else { Some((start, to, topic)) }
}

/// (addressed roles, question) when the agent ended with an ASK block.
fn parse_ask(output: &str) -> Option<(Vec<String>, String)> {
    find_ask(output).map(|(_, to, topic)| (to, topic))
}

/// Deliverable text without the ASK block (it lives in the Discussion instead).
fn strip_ask(output: &str) -> String {
    match find_ask(output) {
        Some((start, _, _)) => output.lines().take(start).collect::<Vec<_>>().join("\n").trim_end().to_string(),
        None => output.to_string(),
    }
}

/// Keep only teammates that exist in this team (minus the asker), in team order;
/// "all" expands to everyone. "human" is passed through and sorted last so a
/// need-human escalation only fires after the teammates had their say.
/// Falls back to the PO so a question never lands nowhere.
fn resolve_targets(to: &[String], team: &[(String, String, String)], from: &str) -> Vec<String> {
    let order = |r: &str| team.iter().position(|(tr, _, _)| tr == r);
    let mut targets: Vec<String> = if to.iter().any(|x| x == "all") {
        team.iter().map(|(r, _, _)| r.clone()).filter(|r| r != from).collect()
    } else {
        to.iter().filter(|r| (*r == "human" && *r != from) || (*r != from && order(r).is_some())).cloned().collect()
    };
    targets.sort_by_key(|r| if r == "human" { usize::MAX } else { order(r).unwrap_or(usize::MAX - 1) });
    targets.dedup();
    if targets.is_empty() && from != "po" && order("po").is_some() {
        targets.push("po".into());
    }
    targets
}

/// Persist a deliverable into the agent's container and mark the step done.
/// `rev` marks a post-meeting revision (rev 2+).
async fn deliver_and_close(app: &App, run_id: &str, role: &str, output: &str, rev: Option<u32>) {
    let (container, deliverable) = match app.agent_container(role).await {
        Some((cid, cname)) => match write_deliverable(app, &cid, run_id, role, output).await {
            Ok(path) => (Some(cname), Some(path)),
            Err(_) => (Some(cname), None),
        },
        None => (None, None),
    };
    let mut store = app.store.lock().unwrap();
    if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role)) {
        step.status = "done".into();
        step.output = output.to_string();
        step.container = container;
        step.deliverable = deliverable;
        step.finished_at = now_secs();
        if rev.is_some() { step.rev = rev; }
    }
    save_runs(&store);
}

/// True once POST /runs/{id}/stop flagged this run.
fn stop_requested(app: &App, run_id: &str) -> bool {
    app.store.lock().unwrap().runs.iter().find(|r| r.id == run_id).map(|r| r.stop_requested).unwrap_or(false)
}

/// Close a run: mark remaining pending steps "skipped", set the final status/phase, persist.
fn finish_run(app: &App, run_id: &str, status: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        if run.status != "running" && run.status != "waiting_human" { return; }
        for step in run.steps.iter_mut().filter(|s| s.status == "pending") {
            step.status = "skipped".into();
        }
        run.status = status.into();
        run.phase = "done".into();
        for d in run.discussions.iter_mut().filter(|d| d.status != "resolved") {
            d.status = "resolved".into();
            d.answering = None;
        }
        save_runs(&store);
    }
}

/// Outcome of a need-human wait.
enum HumanOutcome { Answered, Stopped, TimedOut }

/// Pause the run (status waiting_human) and poll once a second for the user's
/// reply in the discussion, a Stop, or the timeout. The lock is taken and
/// dropped inside each tick — never held across an await.
async fn wait_for_human(app: &App, run_id: &str, disc_id: &str) -> HumanOutcome {
    let mut human_seen = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .and_then(|r| r.discussions.iter().find(|d| d.id == disc_id))
            .map(|d| d.messages.iter().filter(|m| m.from == "human").count())
            .unwrap_or(0)
    };
    let deadline = now_secs() + HUMAN_TIMEOUT_SECS;
    loop {
        {
            let mut store = app.store.lock().unwrap();
            let run = match store.runs.iter_mut().find(|r| r.id == run_id) {
                Some(r) => r,
                None => return HumanOutcome::TimedOut,
            };
            if run.stop_requested {
                // leave the status as-is — finish_run() closes the run properly
                return HumanOutcome::Stopped;
            }
            if let Some(disc) = run.discussions.iter().find(|d| d.id == disc_id) {
                let humans = disc.messages.iter().filter(|m| m.from == "human").count();
                if humans > human_seen {
                    // got the answer — resume the run and hand control back to the meeting
                    if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                        disc.status = "answering".into();
                    }
                    run.status = "running".into();
                    save_runs(&store);
                    return HumanOutcome::Answered;
                }
            }
            if now_secs() >= deadline {
                run.status = "running".into();
                if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                    disc.messages.push(MeetingMessage {
                        from: "orchestrator".into(),
                        text: "no answer from the user in time — the team proceeds with its best judgment".into(),
                        at: now_secs(),
                    });
                    disc.status = "answering".into();
                }
                save_runs(&store);
                return HumanOutcome::TimedOut;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        human_seen = {
            let store = app.store.lock().unwrap();
            store.runs.iter().find(|r| r.id == run_id)
                .and_then(|r| r.discussions.iter().find(|d| d.id == disc_id))
                .map(|d| d.messages.iter().filter(|m| m.from == "human").count())
                .unwrap_or(human_seen)
        };
    }
}

/// Open a need-human wait: flag the discussion + run, leave a note in the chat.
fn escalate_to_human(app: &App, run_id: &str, disc_id: &str, question: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        run.status = "waiting_human".into();
        if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
            disc.status = "need_human".into();
            disc.answering = Some("human".into());
            disc.messages.push(MeetingMessage {
                from: "orchestrator".into(),
                text: format!("🧑 the team cannot resolve this without you — please answer in the chat: {question}"),
                at: now_secs(),
            });
        }
        save_runs(&store);
    }
}

/// Team run engine with a meeting loop.
///
/// Round 1 is a relay: each persona produces its piece of work, sees what
/// earlier teammates produced, and (when it has a running container) writes its
/// deliverable into that container as a real file. Any agent may end its reply
/// with an "## ASK" block — a blocking question addressed to specific teammates.
///
/// Each ASK opens a live meeting: the addressed teammates answer one by one,
/// then the asker revises their deliverable with the answers. A revision may
/// raise a new ASK (bounded by MAX_MEETING_ROUNDS). Finally the PO closes the
/// mission with a summary.
async fn execute_run(app: App, run_id: String) {
    let (project_name, project_id, task, roles) = {
        let store = app.store.lock().unwrap();
        let run = match store.runs.iter().find(|r| r.id == run_id) {
            Some(r) => r.clone(),
            None => return,
        };
        (run.project_name, run.project_id.clone(), run.task, run.steps.iter().map(|s| (s.role.clone(), s.name.clone(), s.title.clone())).collect::<Vec<_>>())
    };

    // Bot-on-a-Linux-box rule, team edition: before the relay starts, the first
    // running agent container clones the project repo into the shared
    // /workspace volume — every teammate then works on that one real working
    // tree, and all file changes go through the repo only.
    let repo_url = {
        let store = app.store.lock().unwrap();
        store.projects.iter().find(|p| p.id == project_id)
            .or_else(|| store.projects.iter().find(|p| p.name == project_name))
            .map(|p| p.repo_url.clone())
            .unwrap_or_default()
    };
    let (repo_path, repo_error) = if repo_url.is_empty() {
        (None, None)
    } else {
        let mut outcome: Option<Result<String, ApiError>> = None;
        for (role, _, _) in &roles {
            if let Some((cid, _)) = app.agent_container(role).await {
                outcome = Some(app.ensure_repo(&cid, &repo_url).await);
                break;
            }
        }
        match outcome {
            Some(Ok(path)) => (Some(path), None),
            Some(Err(e)) => (None, Some(e.1)),
            // no agent container running — the run proceeds text-only, as before
            None => (None, None),
        }
    };
    let repo_line = repo_path.as_deref()
        .map(|p| format!(" The project repository is already cloned in the team workspace at {p} — when your part involves code or files, work against that repo's real files (cite real paths from it); all file changes go through this repo only."))
        .unwrap_or_default();
    let repo_note = repo_error.map(|e| format!("\n\n## Note from the orchestrator\nThe project repo could not be cloned into the team workspace ({e}) — deliver text deliverables only this run."));

    // (name, title, rules, model) for a role, straight from the persona store
    let persona_of = |role: &str| -> (String, String, String, Option<String>) {
        let p = { app.store.lock().unwrap().personas.iter().find(|p| p.role == role).cloned() };
        match p {
            Some(p) => (p.name.clone(), p.title.clone(), p.rules_md.clone(), app.model_for_persona(Some(&p))),
            None => (role.to_string(), String::new(), String::new(), None),
        }
    };

    // Shared work prompt: deliver YOUR part; ASK only when genuinely blocked.
    let work_system = |rules: &str, name: &str, title: &str| {
        format!(
            "{rules}\n\nYou are {name}, {title}, one member of an AI agent team on project '{project_name}'. \
The user gave the team ONE task. The team works together like a real software team: the PO opens the mission, the BA analyzes the business side, the SA turns it into the system spec that briefs UX/UI, Dev and QA each directly, then every specialist delivers their part against that spec.{repo_line} \
Treat earlier teammates' output as your input — do YOUR part only, do not repeat or redo teammates' work; build on it, fill the gaps your expertise covers. \
Reply with your concrete work deliverable in markdown (tight headings, lists, tables or code where useful — no filler, no apologies). \
Answer in the same language the task is written in. Keep it under ~450 words. \
If something genuinely blocks your part or is unclear, you may end your reply with a section exactly titled \"## ASK\" containing a line \"to: role1, role2\" (teammates who must answer — \"all\" for the whole team, \"human\" for the user) and 1-3 concise questions. Use it sparingly: only when you cannot do your part correctly without the answer. Address \"human\" ONLY when the missing piece is information or a decision that neither you nor any teammate can produce (credentials, business intent, external approval) — the whole team pauses until the user replies."
        )
    };

    // Register (or re-register) an ASK as a discussion; returns false when it targets no one.
    let raise_discussion = |from: &str, to: &[String], topic: &str, round: u32| -> bool {
        let targets = resolve_targets(to, &roles, from);
        if targets.is_empty() { return false; }
        let mut store = app.store.lock().unwrap();
        if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
            run.discussions.push(Discussion {
                id: format!("d-{:03}", run.discussions.len() + 1),
                kind: String::new(),
                from: from.into(),
                to: targets,
                topic: topic.into(),
                status: "open".into(),
                answering: None,
                messages: Vec::new(),
                round,
                created_at: now_secs(),
            });
        }
        save_runs(&store);
        true
    };

    // Persist a deliverable into the agent's container and mark the step done.
    // (standalone fn — see deliver_and_close below)

    // ---- Round 1: relay — each teammate delivers, may raise an ASK ----
    for (role, name, title) in &roles {
        // Stop checkpoint: the user pressed Stop — skip everything still pending.
        if stop_requested(&app, &run_id) {
            finish_run(&app, &run_id, "stopped");
            return;
        }
        let (role, name, title) = (role.clone(), name.clone(), title.clone());
        let (pname, _ptitle, rules, model) = persona_of(&role);

        // step → working (records the model this step will run with, even if it later errors)
        {
            let mut store = app.store.lock().unwrap();
            if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role)) {
                step.status = "working".into();
                step.model = model.clone();
                step.started_at = now_secs();
            }
            save_runs(&store);
        }

        // Handoff context: what earlier teammates already produced
        let mut handoff = String::new();
        {
            let store = app.store.lock().unwrap();
            if let Some(run) = store.runs.iter().find(|r| r.id == run_id) {
                for s in run.steps.iter().take_while(|s| s.role != role) {
                    if s.status == "done" && !s.output.is_empty() {
                        let brief: String = s.output.chars().take(1400).collect();
                        handoff.push_str(&format!("\n### {} — {} (done)\n{}\n", s.name, s.title, brief));
                    }
                }
            }
        }

        let system = work_system(&rules, &pname, &title);
        let first_note = repo_note.as_deref().unwrap_or("");
        let user = if handoff.is_empty() {
            format!("## Task from the user\n{task}{first_note}\n\nYou are the first teammate to answer. Deliver your part.")
        } else {
            format!("## Task from the user\n{task}\n\n## What teammates before you already produced\n{handoff}\n\nNow deliver YOUR part ({title}).")
        };

        let result = match model.as_deref() {
            Some(m) => app.llm_max(m, &system, &user, 1400).await,
            None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
        };
        match result {
            Ok(output) if !output.is_empty() => {
                let clean = strip_ask(&output);
                deliver_and_close(&app, &run_id, &role, &clean, None).await;
                if let Some((to, topic)) = parse_ask(&output) {
                    raise_discussion(&role, &to, &topic, 1);
                }
            }
            Ok(_) => {
                let mut store = app.store.lock().unwrap();
                if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role)) {
                    step.status = "error".into();
                    step.output = "Model returned an empty answer".into();
                    step.finished_at = now_secs();
                }
                save_runs(&store);
            }
            Err(e) => {
                let mut store = app.store.lock().unwrap();
                if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role)) {
                    step.status = "error".into();
                    step.output = e.1;
                    step.finished_at = now_secs();
                }
                save_runs(&store);
            }
        }
    }

    // ---- Meeting loop: answer → revise, until nothing is open (bounded) ----
    let mut meeting_round: u32 = 0;
    loop {
        if stop_requested(&app, &run_id) {
            finish_run(&app, &run_id, "stopped");
            return;
        }
        let open: Vec<Discussion> = {
            let store = app.store.lock().unwrap();
            match store.runs.iter().find(|r| r.id == run_id) {
                Some(r) => r.discussions.iter().filter(|d| d.status == "open").cloned().collect(),
                None => return,
            }
        };
        if open.is_empty() || meeting_round >= MAX_MEETING_ROUNDS {
            // Cap reached with questions still open → escalate them to the human
            // (the team genuinely could not settle this itself), then close.
            if meeting_round >= MAX_MEETING_ROUNDS {
                let stuck: Vec<(String, String)> = {
                    let store = app.store.lock().unwrap();
                    store.runs.iter().find(|r| r.id == run_id)
                        .map(|r| r.discussions.iter().filter(|d| d.status == "open").map(|d| (d.id.clone(), d.topic.clone())).collect())
                        .unwrap_or_default()
                };
                for (disc_id, topic) in stuck {
                    escalate_to_human(&app, &run_id, &disc_id, &topic);
                    match wait_for_human(&app, &run_id, &disc_id).await {
                        HumanOutcome::Answered | HumanOutcome::TimedOut => {
                            let mut store = app.store.lock().unwrap();
                            if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                                if let Some(disc) = run.discussions.iter_mut().find(|x| x.id == disc_id) {
                                    disc.status = "resolved".into();
                                    disc.answering = None;
                                }
                            }
                            save_runs(&store);
                        }
                        HumanOutcome::Stopped => {
                            finish_run(&app, &run_id, "stopped");
                            return;
                        }
                    }
                }
            }
            break;
        }
        meeting_round += 1;
        {
            let mut store = app.store.lock().unwrap();
            if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                run.phase = "meeting".into();
                run.round = meeting_round + 1;
            }
            save_runs(&store);
        }

        for d in open {
            if stop_requested(&app, &run_id) {
                finish_run(&app, &run_id, "stopped");
                return;
            }
            let (fname, ftitle, ..) = persona_of(&d.from);
            {
                let mut store = app.store.lock().unwrap();
                if let Some(disc) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.discussions.iter_mut().find(|x| x.id == d.id)) {
                    disc.status = "answering".into();
                }
                save_runs(&store);
            }

            // Each addressed teammate answers in turn (live: one message at a time);
            // "human" pauses the whole run until the user answers in the web chat.
            for target in &d.to {
                if target == "human" {
                    escalate_to_human(&app, &run_id, &d.id, &d.topic);
                    match wait_for_human(&app, &run_id, &d.id).await {
                        HumanOutcome::Answered | HumanOutcome::TimedOut => { /* the answer is already in messages */ }
                        HumanOutcome::Stopped => {
                            finish_run(&app, &run_id, "stopped");
                            return;
                        }
                    }
                    continue;
                }
                let (tname, ttitle, trules, tmodel) = persona_of(target);
                {
                    let mut store = app.store.lock().unwrap();
                    if let Some(disc) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.discussions.iter_mut().find(|x| x.id == d.id)) {
                        disc.answering = Some(target.clone());
                    }
                    save_runs(&store);
                }
                let asker_work: String = {
                    let store = app.store.lock().unwrap();
                    store.runs.iter().find(|r| r.id == run_id)
                        .and_then(|r| r.steps.iter().find(|s| s.role == d.from))
                        .map(|s| s.output.chars().take(700).collect())
                        .unwrap_or_default()
                };
                let system = format!(
                    "{trules}\n\nYou are {tname}, {ttitle}, in a live team meeting on project '{project_name}'. \
A teammate raised a blocking question that needs your expertise. Answer directly and concisely (≤150 words) — give a decision or a clarification, no pleasantries, same language as the mission."
                );
                let user = format!(
                    "## Mission\n{task}\n\n## Question from {fname} ({ftitle})\n{}\n\n## Excerpt — {fname}'s work\n{asker_work}\n\nYour answer:",
                    d.topic,
                );
                let answer = match tmodel.as_deref() {
                    Some(m) => app.llm_max(m, &system, &user, 350).await,
                    None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
                };
                let text = match answer {
                    Ok(t) if !t.is_empty() => t.trim().chars().take(900).collect::<String>(),
                    Ok(_) => "(empty answer)".into(),
                    Err(e) => format!("⚠️ could not answer: {}", e.1),
                };
                let mut store = app.store.lock().unwrap();
                if let Some(disc) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.discussions.iter_mut().find(|x| x.id == d.id)) {
                    disc.messages.push(MeetingMessage { from: target.clone(), text, at: now_secs() });
                }
                save_runs(&store);
            }

            // The asker revises their deliverable with the answers
            let (aname, atitle, arules, amodel) = persona_of(&d.from);
            let (prev, msgs) = {
                let store = app.store.lock().unwrap();
                let run = match store.runs.iter().find(|r| r.id == run_id) { Some(r) => r, None => return };
                let prev: String = run.steps.iter().find(|s| s.role == d.from).map(|s| s.output.chars().take(1200).collect()).unwrap_or_default();
                let msgs = run.discussions.iter().find(|x| x.id == d.id).map(|x| x.messages.clone()).unwrap_or_default();
                (prev, msgs)
            };
            let answers = msgs.iter()
                .map(|m| {
                    let speaker = if m.from == "human" { "the user".to_string() } else if m.from == "orchestrator" { "orchestrator".to_string() } else { persona_of(&m.from).0 };
                    format!("- **{}** ({}): {}", speaker, m.from, m.text)
                })
                .collect::<Vec<_>>().join("\n");
            {
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    if let Some(step) = run.steps.iter_mut().find(|s| s.role == d.from) { step.status = "working".into(); step.started_at = now_secs(); }
                    if let Some(disc) = run.discussions.iter_mut().find(|x| x.id == d.id) { disc.answering = Some(d.from.clone()); }
                }
                save_runs(&store);
            }
            let system = work_system(&arules, &aname, &atitle);
            let user = format!(
                "## Task from the user\n{task}\n\n## Your earlier deliverable\n{prev}\n\n## Your question to the team\n{}\n\n## Answers from the team\n{answers}\n\nRevise and resend YOUR full deliverable (same format rules, ≤450 words). If you are still blocked you may end with another \"## ASK\" section.",
                d.topic,
            );
            let result = match amodel.as_deref() {
                Some(m) => app.llm_max(m, &system, &user, 1400).await,
                None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
            };
            match result {
                Ok(output) if !output.is_empty() => {
                    let clean = strip_ask(&output);
                    deliver_and_close(&app, &run_id, &d.from, &clean, Some(meeting_round + 1)).await;
                    // The question as asked is answered either way; a still-blocked asker raises a NEW discussion.
                    match parse_ask(&output) {
                        Some((to, topic)) => { raise_discussion(&d.from, &to, &topic, meeting_round + 1); }
                        None => {}
                    }
                }
                // Revision failed — keep the round-1 deliverable, it is still valid work
                _ => {
                    let mut store = app.store.lock().unwrap();
                    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                        if let Some(step) = run.steps.iter_mut().find(|s| s.role == d.from) { step.status = "done".into(); step.finished_at = now_secs(); }
                    }
                    save_runs(&store);
                }
            }
            {
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    if let Some(disc) = run.discussions.iter_mut().find(|x| x.id == d.id) {
                        disc.status = "resolved".into();
                        disc.answering = None;
                    }
                }
                save_runs(&store);
            }
        }
    }

    // ---- PO closes the mission with one summary ----
    if roles.iter().any(|(r, _, _)| r == "po") {
        let (pname, ptitle, prules, pmodel) = persona_of("po");
        let (deliverables, meetings) = {
            let store = app.store.lock().unwrap();
            let run = match store.runs.iter().find(|r| r.id == run_id) { Some(r) => r, None => return };
            let deliverables = run.steps.iter().map(|s| format!("- {} ({}): {}", s.name, s.role, s.status)).collect::<Vec<_>>().join("\n");
            let meetings = run.discussions.iter()
                .map(|d| format!("- Q by {}: {} → answered by [{}], {} message(s)", d.from, d.topic.chars().take(120).collect::<String>(), d.to.join(", "), d.messages.len()))
                .collect::<Vec<_>>().join("\n");
            (deliverables, meetings)
        };
        let system = format!(
            "{prules}\n\nYou are {pname}, closing a team mission on project '{project_name}'. \
Write ONE tight summary (≤200 words) of what the team produced and what the meetings decided — decisions and outcomes only, same language as the mission."
        );
        let user = format!("## Mission\n{task}\n\n## Deliverables\n{deliverables}\n\n## Meetings\n{meetings}\n\nWrite the mission summary.");
        let result = match pmodel.as_deref() {
            Some(m) => app.llm_max(m, &system, &user, 500).await,
            None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
        };
        if let Ok(summary) = result {
            if !summary.is_empty() {
                if let Some((cid, _)) = app.agent_container("po").await {
                    let _ = write_deliverable(&app, &cid, &run_id, "summary", &summary).await;
                }
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    run.summary = Some(summary);
                }
                save_runs(&store);
            }
        }
    }

    // ---- Close the run, then let the PO decide the next loop iteration ----
    let all_error = {
        let mut store = app.store.lock().unwrap();
        let all_error = match store.runs.iter_mut().find(|r| r.id == run_id) {
            Some(run) => {
                run.status = if run.steps.iter().all(|s| s.status == "error") { "error".into() } else { "done".into() };
                run.phase = "done".into();
                run.steps.iter().all(|s| s.status == "error")
            }
            None => return,
        };
        save_runs(&store);
        all_error
    };

    // Loop mode: the PO looks at the whole chain so far and either writes the
    // next iteration's task or declares the goal done.
    let (loop_mode, iteration) = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id).map(|r| (r.loop_mode, r.iteration)).unwrap_or((false, 1))
    };
    if loop_mode && !all_error && !stop_requested(&app, &run_id) && iteration < MAX_LOOP_ITERATIONS {
        let (pname, _ptitle, prules, pmodel) = persona_of("po");
        if let Some(model) = pmodel {
            let chain = {
                let store = app.store.lock().unwrap();
                store.runs.iter()
                    .filter(|r| r.project_id == project_id && r.loop_mode)
                    .map(|r| format!("### Iteration {} — {}\nSummary: {}", r.iteration, r.task, r.summary.as_deref().map(|s| s.chars().take(500).collect::<String>()).unwrap_or_else(|| "(none)".into())))
                    .collect::<Vec<_>>().join("\n\n")
            };
            let system = format!(
                "{prules}\n\nYou are {pname}, the PO of an AI team running in a LOOP on project '{project_name}'. \
The loop's standing goal is the ORIGINAL task. After each iteration you decide what the team should do next. \
Reply with EITHER the concrete task for the next iteration (one sentence, same language as the goal, ≤60 words — build on what is already done, do not repeat it) OR exactly `DONE` when the goal is achieved and no further iteration adds value."
            );
            let user = format!("## Standing goal\n{task}\n\n## Iterations so far\n{chain}\n\nDecide: the next iteration's task, or `DONE`.");
            if let Ok(next) = app.llm_max(&model, &system, &user, 200).await {
                let next = next.trim().trim_matches('`').to_string();
                if !next.is_empty() && !next.eq_ignore_ascii_case("done") && next.len() < 600 {
                    let next_task = next.lines().last().unwrap_or(&next).to_string();
                    if let Ok(child) = spawn_run(&app, &project_id, &next_task, true, iteration + 1) {
                        let mut store = app.store.lock().unwrap();
                        if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                            run.next_run_id = Some(child.id.clone());
                        }
                        save_runs(&store);
                    }
                }
            }
        }
    }
}

/// Create a run for the project's current team, store it and start
/// `execute_run` in the background. Shared by the API handler and the loop
/// engine (each loop iteration spawns the next run this way). Returns the
/// stored run — its `.id` is what links a loop chain via `next_run_id`.
fn spawn_run(app: &App, project_id: &str, task: &str, loop_mode: bool, iteration: u32) -> Result<Run, ApiError> {
    let run = {
        let mut store = app.store.lock().unwrap();
        let p = store.projects.iter().find(|p| p.id == project_id)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Project '{project_id}' not found")))?;
        let (project_name, agents) = (p.name.clone(), p.agents.clone());
        if agents.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "Project has no team — add agents on the flow first"));
        }
        let personas = store.personas.clone();
        let steps = agents.iter()
            .filter_map(|role| personas.iter().find(|p| p.role == *role).map(|p| RunStep {
                role: p.role.clone(), name: p.name.clone(), title: p.title.clone(),
                kind: "work".into(),
                status: "pending".into(), output: String::new(),
                model: None, container: None, deliverable: None, rev: None,
                started_at: 0, finished_at: 0,
            }))
            .collect::<Vec<_>>();
        if steps.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "None of the project's agents exist as personas"));
        }
        store.run_counter += 1;
        let run = Run {
            id: format!("run-{:03}", store.run_counter),
            project_id: project_id.to_string(),
            project_name,
            task: task.to_string(),
            status: "running".into(),
            steps,
            phase: "working".into(),
            round: 1,
            discussions: Vec::new(),
            summary: None,
            acceptance: None,
            created_at: now_secs(),
            loop_mode,
            iteration,
            stop_requested: false,
            next_run_id: None,
        };
        store.runs.push(run.clone());
        save_runs(&store);
        run
    };
    let bg_app = app.clone();
    let run_id = run.id.clone();
    tokio::spawn(async move { execute_run(bg_app, run_id).await });
    Ok(run)
}

async fn run_project(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>, Json(req): Json<RunRequest>) -> ApiResult {
    app.require_auth(&headers)?;
    let task = req.task.trim().to_string();
    if task.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "task is required"));
    }
    // Heavy lifting happens in the background; the UI polls GET /runs/{id}
    let run = spawn_run(&app, &id, &task, req.run_loop, 1)?;
    Ok(json_ok(serde_json::to_value(run).unwrap()))
}

async fn list_runs(State(app): State<App>) -> Json<Vec<Run>> {
    let mut runs = app.store.lock().unwrap().runs.clone();
    runs.reverse();
    Json(runs)
}

async fn get_run(State(app): State<App>, Path(run_id): Path<String>) -> ApiResult {
    let run = app.store.lock().unwrap().runs.iter().find(|r| r.id == run_id).cloned();
    match run {
        Some(r) => Ok(json_ok(serde_json::to_value(r).unwrap())),
        None => Err(err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found"))),
    }
}

#[derive(Deserialize)]
struct ReplyRequest {
    text: String,
}

/// The human's answer to a need-human meeting — lands in the chat thread; the
/// engine's 1-second poll picks it up and the run resumes.
async fn reply_discussion(
    State(app): State<App>,
    headers: axum::http::HeaderMap,
    Path((run_id, disc_id)): Path<(String, String)>,
    Json(req): Json<ReplyRequest>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "text is required"));
    }
    let mut store = app.store.lock().unwrap();
    let run = store.runs.iter_mut().find(|r| r.id == run_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found")))?;
    let disc = run.discussions.iter_mut().find(|d| d.id == disc_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Discussion '{disc_id}' not found in run '{run_id}'")))?;
    if disc.status == "resolved" {
        return Err(err(StatusCode::BAD_REQUEST, "This meeting is already resolved"));
    }
    disc.messages.push(MeetingMessage { from: "human".into(), text, at: now_secs() });
    // Only the live need-human wait reacts to the message; otherwise it is kept as a record.
    if disc.status == "need_human" {
        disc.status = "answering".into();
        disc.answering = None;
        if run.status == "waiting_human" {
            run.status = "running".into();
        }
    }
    save_runs(&store);
    Ok(json_ok(json!({ "ok": true })))
}

/// Ask the engine to wind the run down at its next checkpoint (also ends a loop chain).
async fn stop_run(State(app): State<App>, headers: axum::http::HeaderMap, Path(run_id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let status = match store.runs.iter_mut().find(|r| r.id == run_id) {
        Some(run) => {
            if run.status != "running" && run.status != "waiting_human" {
                return Err(err(StatusCode::BAD_REQUEST, format!("Run is already {}", run.status)));
            }
            run.stop_requested = true;
            run.status.clone()
        }
        None => return Err(err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found"))),
    };
    save_runs(&store);
    Ok(json_ok(json!({ "ok": true, "status": status })))
}

/// What one agent is doing right now + everything it has done, across all runs —
/// powers the agent detail dialog on the flow chart. History survives restarts
/// because runs are persisted to /data/runs.json.
async fn agent_activity(State(app): State<App>, Path(role): Path<String>) -> ApiResult {
    let runs = app.store.lock().unwrap().runs.clone();

    // Live state: the newest run that is still in flight (running or paused on a human).
    let mut current: Option<Value> = None;
    for run in runs.iter().filter(|r| r.status == "running" || r.status == "waiting_human") {
        let step = match run.steps.iter().find(|s| s.role == role) { Some(s) => s, None => continue };
        // Speaking in a live meeting beats "working" — it is the more specific state.
        let speaking = run.discussions.iter()
            .find(|d| d.answering.as_deref() == Some(role.as_str()) && d.status != "resolved");
        let waiting_human = run.status == "waiting_human" && run.discussions.iter()
            .any(|d| d.status == "need_human" && (d.from == role || d.to.iter().any(|t| t == &role)));
        let (state, detail, topic) = if let Some(d) = speaking {
            ("speaking".to_string(), format!("กำลังตอบคำถามใน meeting ของ {}", d.from), Some(d.topic.clone()))
        } else if waiting_human {
            let d = run.discussions.iter().find(|d| d.status == "need_human" && (d.from == role || d.to.iter().any(|t| t == &role)));
            ("waiting_human".to_string(), "ทีมรอคำตอบจากคุณอยู่".to_string(), d.map(|d| d.topic.clone()))
        } else if step.status == "working" {
            if step.rev.map(|r| r > 1).unwrap_or(false) {
                ("working".to_string(), "กำลังแก้งานหลัง meeting (revision)".to_string(), None)
            } else {
                ("working".to_string(), "กำลังทำ deliverable ของตัวเอง".to_string(), None)
            }
        } else {
            ("pending".to_string(), "รอรับงานตามลำดับ".to_string(), None)
        };
        current = Some(json!({
            "run_id": run.id,
            "project_id": run.project_id,
            "project_name": run.project_name,
            "task": run.task,
            "state": state,
            "detail": detail,
            "topic": topic,
            "iteration": run.iteration,
            "loop_mode": run.loop_mode,
            "since": if step.started_at > 0 { step.started_at } else { run.created_at },
        }));
        break;
    }

    // History: this agent's step in every run, newest first.
    let mut history: Vec<Value> = runs.iter()
        .filter(|r| r.steps.iter().any(|s| s.role == role))
        .map(|r| {
            let s = r.steps.iter().find(|s| s.role == role).unwrap();
            let meetings = r.discussions.iter()
                .filter(|d| d.from == role || d.to.iter().any(|t| t == &role) || d.messages.iter().any(|m| m.from == role))
                .count();
            let excerpt: String = s.output.chars().take(300).collect();
            json!({
                "run_id": r.id,
                "project_id": r.project_id,
                "project_name": r.project_name,
                "task": r.task,
                "run_status": r.status,
                "status": s.status,
                "rev": s.rev,
                "started_at": s.started_at,
                "finished_at": s.finished_at,
                "output_excerpt": excerpt,
                "deliverable": s.deliverable,
                "container": s.container,
                "meetings": meetings,
                "iteration": r.iteration,
            })
        })
        .collect();
    history.reverse();
    history.truncate(50);

    Ok(json_ok(json!({ "role": role, "current": current, "history": history })))
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

async fn vnc_secret(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    // The VNC password equals ADMIN_PASSWORD (.env) so there is ONE secret.
    // Only handed out to logged-in sessions — the web UI uses it to auto-auth noVNC.
    app.require_auth(&headers)?;
    let password = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
    Ok(json_ok(json!({ "password": password })))
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
        store: {
            let mut store = Store::default();
            load_runs(&mut store); // work history survives restarts (/data/runs.json)
            Arc::new(Mutex::new(store))
        },
        seq: Arc::new(AtomicUsize::new(1)),
    };

    let cors = tower_http::cors::CorsLayer::permissive();

    let router = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/providers", get(list_providers))
        .route("/agent/status", get(agent_status))
        .route("/models", get(list_models))
        .route("/auth/verify", post(verify_admin))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/vnc/secret", get(vnc_secret))
        .route("/containers", get(list_containers).post(create_container))
        .route("/containers/{ident}", delete(delete_container))
        .route("/containers/{ident}/{action}", post(container_action))
        .route("/containers/{ident}/exec", post(exec_command))
        .route("/containers/{ident}/terminal/ws", get(terminal_ws))
        .route("/containers/{ident}/agent", post(agent_command))
        .route("/containers/{ident}/stats", get(container_stats))
        .route("/containers/{ident}/inspect", get(container_inspect))
        .route("/containers/{ident}/files", get(container_files))
        .route("/connectors", get(connectors_catalog))
        .route("/connectors/status", get(connectors_status))
        .route("/containers/{ident}/connectors", get(container_connectors))
        .route("/containers/{ident}/connectors/github/connect", post(github_connect))
        .route("/containers/{ident}/connectors/github/connect-token", post(github_connect_token))
        .route("/containers/{ident}/connectors/github/disconnect", post(github_disconnect))
        .route("/containers/{ident}/connectors/github/open-browser", post(github_open_browser))
        .route("/containers/{ident}/connectors/figma/connect-token", post(figma_connect_token))
        .route("/containers/{ident}/connectors/figma/disconnect", post(figma_disconnect))
        .route("/agents", get(list_agents).post(create_persona))
        .route("/agents/{role}", put(update_persona).delete(delete_persona))
        .route("/agents/{role}/start", post(start_agent))
        .route("/agents/{role}/activity", get(agent_activity))
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{task_id}", delete(delete_task))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{id}", get(get_project).put(update_project).delete(delete_project))
        .route("/projects/{id}/run", post(run_project))
        .route("/runs", get(list_runs))
        .route("/runs/{run_id}", get(get_run))
        .route("/runs/{run_id}/stop", post(stop_run))
        .route("/runs/{run_id}/discussions/{disc_id}/reply", post(reply_discussion))
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
