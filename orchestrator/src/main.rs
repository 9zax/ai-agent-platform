mod hostexec;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use chrono::{Datelike, Local, TimeZone, Timelike};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SERVICE_NAME: &str = "AI Agent Platform Orchestrator";
/// GitHub connector device flow runs against GitHub CLI's public OAuth app —
/// per-container login via browser, tokens never stored by the platform.
const GH_DEVICE_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";
const GH_DEVICE_SCOPE: &str = "repo read:org gist workflow";
/// Derived per-container connector status is cached this many seconds so the
/// UI's 5s polls don't exec `gh auth status` in every container constantly.
const CONNECTOR_CACHE_TTL: u64 = 10;
/// How often the idle sweeper evaluates auto-pause candidates.
const IDLE_SWEEP_INTERVAL_SECS: u64 = 60;
/// Per-doc and total char budgets when project documents are injected into
/// relay prompts (same truncation style as the 1400-char handoff).
const DOC_INJECT_MAX_CHARS: usize = 4000;
const DOCS_INJECT_MAX_CHARS: usize = 16000;
/// Hard cap for one uploaded document file (enforced by the route's body limit too).
const DOC_UPLOAD_MAX_BYTES: usize = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Default tool belt — every agent's Linux box gets these, and every prompt
// states what is actually installed (verified via `command -v`) so the AI
// never guesses capabilities the box doesn't have.
// ---------------------------------------------------------------------------

/// (probe command, hint for the model) — probed on the HOST and rendered into
/// the system prompt. The platform never installs anything on the user's
/// machine; the manifest simply reports what is really there so the model
/// never invents capabilities the machine doesn't have.
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
    ("open", "macOS launcher — open <url> opens the user's real browser window (visible on their screen); open <file> reveals files in Finder"),
    ("rg", "ripgrep — fast code search"),
    ("zip", "create zip archives"),
    ("unzip", "extract zip archives"),
    ("rsync", "file sync / bulk copy"),
    ("ssh", "SSH client — git over ssh, remote commands"),
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
    /// role id of this persona's manager ("" = top of the org)
    #[serde(default)]
    reports_to: String,
    /// native = built-in provider loop; claude/codex/custom = external CLI harness
    #[serde(default = "default_harness")]
    harness: String,
    /// command template for a custom harness ({prompt_file}, {model}, {role} placeholders)
    #[serde(default)]
    harness_command: String,
}

fn default_harness() -> String { "native".into() }

fn seed_personas() -> Vec<Persona> {
    // Per-role model overrides, one per provider family the seeds cover:
    // zai (GLM — the platform default) and gemini. The tiering mirrors across
    // both families — flagship for the reasoning-heavy roles (PO, SA), the
    // flash workhorse for builders/testers (BA, UX, Dev, QA), and the cheapest
    // tier for Chom's applied pattern work (tokens/visual system built on
    // Sept's flows): glm-4.5-air ↔ gemini-3.5-flash-lite.
    //
    // Team-wide working agreement appended to every persona (like the TDD norm,
    // it applies to the whole team): a demo must carry evidence — a screenshot
    // or short video of the actual result. Text-only reports don't count.
    let demo_rule = " Whenever you present or hand off finished work, attach a screenshot or a short video of the actual result — a text-only report is not a demo.";
    let mk = |role: &str, name: &str, title: &str, years: &str, expertise: &str, rules: &str, glm: &str, gemini: &str| Persona {
        role: role.into(), name: name.into(), title: title.into(), years: years.into(),
        expertise: expertise.into(), rules_md: format!("{rules}{demo_rule}"),
        model_overrides: BTreeMap::from([
            (PROVIDERS[0].id.to_string(), glm.to_string()),
            ("gemini".to_string(), gemini.to_string()),
        ]),
        reports_to: String::new(),
        harness: default_harness(),
        harness_command: String::new(),
    };
    // Order = collaboration flow: the PO opens the mission, BA analyzes the
    // business side, SA turns it into the system spec and briefs every
    // specialist (UX/UI, Dev, QA) who then work together on the same run.
    let mut team = vec![
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
    ];
    // Org-lite: the reporting line every agent sees in its prompt.
    let bosses = [
        ("ba", "po"), ("sa", "ba"),
        ("ux-ui", "sa"), ("ux-ui-2", "ux-ui"),
        ("dev-fe", "sa"), ("dev-be", "sa"), ("dev-be-2", "dev-be"),
        ("qa", "sa"),
    ];
    for p in &mut team {
        if let Some((_, boss)) = bosses.iter().find(|(role, _)| *role == p.role) {
            p.reports_to = (*boss).to_string();
        }
    }
    team
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
        goal: "Make ai-agent-platform the best way for one developer to run a real AI software team on their own machine.".into(),
        budget_usd: Some(10.0),
        budget_alert_pct: 80,
    }
}

#[derive(Clone, Serialize, Deserialize)]
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

#[derive(Clone, Serialize, Deserialize)]
struct SkillTestRun {
    id: String,
    input: String,
    output: String,
    model: String,
    at: u64,
    #[serde(default)]
    cost_usd: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct SkillSnapshot {
    version: u32,
    name: String,
    description: String,
    enabled: bool,
    at: u64,
}

fn default_skill_version() -> u32 { 1 }

fn seed_skill(id: &str, name: &str, description: &str, enabled: bool) -> Skill {
    Skill {
        id: id.into(), name: name.into(), description: description.into(), enabled,
        version: 1, test_inputs: Vec::new(), test_runs: Vec::new(), history: Vec::new(),
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Skill {
    id: String,
    name: String,
    description: String,
    enabled: bool,
    #[serde(default = "default_skill_version")]
    version: u32,
    /// saved inputs for the Skill Studio test bench
    #[serde(default)]
    test_inputs: Vec<String>,
    /// results of the last N test runs (newest first, capped)
    #[serde(default)]
    test_runs: Vec<SkillTestRun>,
    /// previous versions (newest first, capped)
    #[serde(default)]
    history: Vec<SkillSnapshot>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Routine {
    id: String,
    project_id: String,
    name: String,
    task: String,
    /// 5-field cron in local time: minute hour dom month dow
    cron: String,
    enabled: bool,
    #[serde(default)]
    loop_mode: bool,
    #[serde(default)]
    last_run_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_run_id: Option<String>,
    #[serde(default)]
    last_result: String,
    #[serde(default)]
    created_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct DocComment {
    id: String,
    project_id: String,
    doc_id: String,
    author: String,
    /// the passage this comment is anchored to (quoted text)
    #[serde(default)]
    quote: String,
    body: String,
    /// open | resolved
    status: String,
    created_at: u64,
    #[serde(default)]
    resolved_at: u64,
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
    /// git remote cloned into the shared workspace before working
    /// (empty = no repo; agents then work on bare workspace files)
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
    /// the standing "why" injected into every step of a mission
    #[serde(default)]
    goal: String,
    /// per-run spend ceiling in USD (None/0 = unlimited)
    #[serde(default)]
    budget_usd: Option<f64>,
    /// warn once when spend crosses this percentage of the budget
    #[serde(default = "default_budget_alert_pct")]
    budget_alert_pct: u8,
}

fn default_budget_alert_pct() -> u8 { 80 }

#[derive(Deserialize)]
struct ProjectCreate {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    repo_url: String,
    #[serde(default)]
    goal: String,
    #[serde(default)]
    budget_usd: Option<f64>,
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
    #[serde(default)] goal: Option<String>,
    #[serde(default)] budget_usd: Option<Option<f64>>,
    #[serde(default)] budget_alert_pct: Option<u8>,
}

// ---------------------------------------------------------------------------
// Project docs — the per-project document space (PO / BA / SA / General).
// Markdown docs live inline in docs.json (editable + injectable into prompts);
// uploaded binaries live on disk under <data>/docs-files/<doc_id>/.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct DocFile {
    /// original filename, sanitized to a bare file name
    name: String,
    content_type: String,
    size: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectDoc {
    /// "d-NNN" (global doc_counter — meetings reuse the prefix inside runs, different namespace)
    id: String,
    project_id: String,
    /// free-text folder; the UI quick-picks PO / BA / SA / General
    folder: String,
    title: String,
    /// markdown body — empty for uploaded binary documents
    #[serde(default)]
    content_md: String,
    /// uploaded binary payload (None for markdown docs)
    #[serde(default)]
    file: Option<DocFile>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Deserialize)]
struct DocCreate {
    title: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    content_md: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DocUpdate {
    #[serde(default)] title: Option<String>,
    #[serde(default)] folder: Option<String>,
    #[serde(default)] content_md: Option<String>,
}

#[derive(Deserialize)]
struct DocQuery {
    /// "?raw=1" → stream the bytes instead of JSON
    #[serde(default)]
    raw: Option<String>,
}

#[derive(Deserialize)]
struct DocCommentCreate {
    body: String,
    #[serde(default)]
    quote: String,
    #[serde(default)]
    author: String,
}

#[derive(Deserialize)]
struct DocCommentUpdate {
    /// open | resolved
    status: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct ModelPrice {
    #[serde(default)]
    input_per_mtok: f64,
    #[serde(default)]
    output_per_mtok: f64,
}

#[derive(Clone, Serialize, Deserialize)]
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
    /// auto-pause containers that have been idle this long (idle sweeper enforces)
    auto_pause_enabled: bool,
    /// idle threshold in seconds before the sweeper stops a container
    idle_timeout_secs: u64,
    /// per-model USD per million tokens (approximate — edit in AI Config)
    #[serde(default)]
    pricing: BTreeMap<String, ModelPrice>,
    #[serde(default)]
    default_input_per_mtok: f64,
    #[serde(default)]
    default_output_per_mtok: f64,
}

fn seeded_pricing() -> BTreeMap<String, ModelPrice> {
    let mut m = BTreeMap::new();
    let mut put = |id: &str, input: f64, output: f64| {
        m.insert(id.to_string(), ModelPrice { input_per_mtok: input, output_per_mtok: output });
    };
    // Approximate public list prices. Users can correct them in AI Config;
    // budget enforcement is only as accurate as this table.
    put("glm-5.3", 0.6, 2.2);
    put("glm-5.3-flash", 0.3, 1.2);
    put("glm-4.5-air", 0.2, 0.8);
    put("claude-opus-5-5", 15.0, 75.0);
    put("claude-sonnet-5-5", 3.0, 15.0);
    put("claude-haiku-5-5", 0.8, 4.0);
    put("gpt-5.5", 1.25, 10.0);
    put("gemini-4-argon", 1.25, 10.0);
    put("gemini-3.8-flash", 0.3, 1.0);
    put("gemini-3.5-flash-lite", 0.1, 0.4);
    m
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
            auto_pause_enabled: true,
            idle_timeout_secs: 900,
            pricing: seeded_pricing(),
            default_input_per_mtok: 0.0,
            default_output_per_mtok: 0.0,
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
    /// which pipeline stage this step belongs to: work (relay deliverable) | pr | demo
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
    /// external CLI harness used for this step (None = built-in provider loop)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    harness: Option<String>,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    /// estimated USD for this step (token-based; 0 for unmetered harnesses)
    #[serde(default)]
    cost_usd: f64,
    /// false = external harness / unpriced model — cost is not a real measurement
    #[serde(default = "default_true")]
    metered: bool,
    /// false = model missing from the price table — cost shows as an estimate only
    #[serde(default = "default_true")]
    priced: bool,
}

fn default_true() -> bool { true }

/// Pre-push review state for a mission (diff approval gate).
#[derive(Clone, Serialize, Deserialize)]
struct RunReview {
    /// pending | approved | rejected | timed_out
    status: String,
    #[serde(default)]
    diff: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    comment: String,
    #[serde(default)]
    requested_at: u64,
    #[serde(default)]
    decided_at: u64,
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
    /// manual | scheduled | loop | retry
    #[serde(default = "default_trigger")]
    trigger: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    routine_id: Option<String>,
    /// project goal snapshot — history survives later goal edits
    #[serde(default)]
    goal: String,
    /// per-run budget snapshot (None = unlimited)
    #[serde(default)]
    budget_usd: Option<f64>,
    #[serde(default)]
    cost_usd: f64,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    /// true once the budget alert threshold has been reported for this run
    #[serde(default)]
    cost_alerted: bool,
    /// pre-push diff review (None = gate not reached / skipped)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    review: Option<RunReview>,
    /// watchdog: no heartbeat from the engine for too long (None = healthy).
    /// Advisory only — it never changes the run's status; the user decides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    watchdog_note: Option<String>,
    #[serde(default)]
    watchdog_at: u64,
}

fn default_trigger() -> String { "manual".into() }

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

/// A container this platform stopped itself (manual Pause or the idle sweeper).
/// Docker labels are gone with host execution; this app-side registry —
/// persisted to /data/paused.json — is the source of truth for "paused"
/// (as opposed to a container the user stopped directly).
#[derive(Clone, Serialize, Deserialize)]
struct PausedInfo {
    /// unix secs when the pause happened
    since: u64,
    /// true = idle sweeper, false = a human pressed Pause
    auto: bool,
}

struct Store {
    personas: Vec<Persona>,
    tasks: Vec<Task>,
    skills: Vec<Skill>,
    projects: Vec<Project>,
    /// per-project document space (persisted, /data/docs.json)
    docs: Vec<ProjectDoc>,
    /// review comments anchored to doc passages (persisted with docs.json)
    doc_comments: Vec<DocComment>,
    runs: Vec<Run>,
    /// scheduled routines (persisted, /data/routines.json)
    routines: Vec<Routine>,
    config: AiConfig,
    /// login sessions: token → username (web UI auth, ADMIN_USER/ADMIN_PASSWORD from env)
    sessions: HashMap<String, String>,
    models_cache: Option<ModelsCache>,
    /// container id → active GitHub device flow (expires on its own)
    pending_device_flows: HashMap<String, PendingDeviceFlow>,
    /// container id → recently probed connector status (CONNECTOR_CACHE_TTL)
    connector_cache: HashMap<String, CachedConnectorStatus>,
    /// container name → platform-paused info (persisted, /data/paused.json)
    paused: HashMap<String, PausedInfo>,
    /// agent name → unix secs of last real activity (in-memory only)
    last_activity: HashMap<String, u64>,
    /// every agent ever started on this machine (persisted, /data/agents.json)
    /// — tmux sessions are ephemeral, this registry is what keeps stopped
    /// agents visible (with a Start button) on the dashboard
    agents: BTreeSet<String>,
    task_counter: usize,
    project_counter: usize,
    doc_counter: usize,
    comment_counter: usize,
    run_counter: usize,
    routine_counter: usize,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            personas: seed_personas(),
            tasks: Vec::new(),
            skills: vec![
                seed_skill("web-research", "Web Research", "Search, crawl and summarize web sources", true),
                seed_skill("code-gen", "Code Gen", "Generate and refactor code from natural language", true),
                seed_skill("data-analysis", "Data Analysis", "Analyze datasets and produce reports and charts", true),
                seed_skill("file-ops", "File Ops", "Read, write and organize files in the workspace", true),
                seed_skill("api-testing", "API Testing", "Call APIs and validate responses against schemas", true),
                seed_skill("image-analysis", "Image Analysis", "Inspect and describe images", false),
            ],
            projects: vec![seed_project()],
            docs: Vec::new(),
            doc_comments: Vec::new(),
            runs: Vec::new(),
            routines: Vec::new(),
            config: AiConfig::default(),
            sessions: HashMap::new(),
            models_cache: None,
            pending_device_flows: HashMap::new(),
            connector_cache: HashMap::new(),
            paused: HashMap::new(),
            last_activity: HashMap::new(),
            agents: BTreeSet::new(),
            task_counter: 0,
            project_counter: 1,
            doc_counter: 0,
            comment_counter: 0,
            run_counter: 0,
            routine_counter: 0,
        }
    }
}

#[derive(Clone)]
struct App {
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
#[allow(dead_code)] // image/command accepted for API compatibility, ignored on host
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
    #[serde(default)] reports_to: Option<String>,
    #[serde(default)] harness: Option<String>,
    #[serde(default)] harness_command: Option<String>,
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
    auto_pause_enabled: Option<bool>,
    idle_timeout_secs: Option<u64>,
    #[serde(default)] pricing: Option<BTreeMap<String, ModelPrice>>,
    #[serde(default)] default_input_per_mtok: Option<f64>,
    #[serde(default)] default_output_per_mtok: Option<f64>,
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
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct SkillTestsInput {
    inputs: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SkillRunRequest {
    /// override the saved bench inputs for this run
    inputs: Option<Vec<String>>,
    /// override the model (defaults to the active provider's default)
    model: Option<String>,
}

/// Token usage reported by one provider call (0/0 when the provider omits it).
#[derive(Clone, Copy, Default)]
struct LlmUsage {
    input_tokens: u64,
    output_tokens: u64,
}

// ---------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------

impl App {
    /// Derived agent state: running (live tmux session) / paused (registry
    /// entry, session killed) / exited (registered but not alive).
    async fn agent_state(&self, name: &str) -> String {
        if hostexec::session_alive(name).await {
            return "running".into();
        }
        if self.store.lock().unwrap().paused.contains_key(name) {
            return "paused".into();
        }
        "exited".into()
    }

    /// Resolve an endpoint ident to an agent this platform knows: registered
    /// in agents.json or currently alive as a session. 404 otherwise.
    async fn resolve_agent(&self, ident: &str) -> Result<String, ApiError> {
        if self.store.lock().unwrap().agents.contains(ident)
            || hostexec::session_alive(ident).await
        {
            return Ok(ident.to_string());
        }
        Err(err(StatusCode::NOT_FOUND, format!("Agent '{ident}' not found")))
    }

    /// Remember an agent (persisted) and mark it active.
    fn register_agent(&self, name: &str) {
        let mut store = self.store.lock().unwrap();
        if store.agents.insert(name.to_string()) {
            save_agents(&store);
        }
    }

    fn unregister_agent(&self, name: &str) {
        let mut store = self.store.lock().unwrap();
        if store.agents.remove(name) {
            save_agents(&store);
        }
    }

    /// Find this platform's agent for a persona role → (name, name). The
    /// session is ensured on the spot (agents start on demand — the tmux
    /// equivalent of a container being there), and a PLATFORM-paused agent is
    /// transparently revived (the idle sweeper may have killed the session
    /// hours ago). None only when the machine itself can't host commands
    /// (workspace unwritable) — runs keep their degrade-to-text semantics.
    async fn agent_container(&self, role: &str) -> Option<(String, String)> {
        let name = hostexec::session_name(role);
        if let Err(e) = hostexec::ensure_session(&name).await {
            eprintln!("agent session '{name}' unavailable: {e}");
            return None;
        }
        self.clear_paused(&name);
        self.touch_activity(&name);
        Some((name.clone(), name))
    }

    fn mark_paused(&self, name: &str, auto: bool) {
        let mut store = self.store.lock().unwrap();
        store.paused.insert(name.to_string(), PausedInfo { since: now_secs(), auto });
        store.last_activity.remove(name);
        save_paused(&store);
    }

    fn clear_paused(&self, name: &str) {
        let mut store = self.store.lock().unwrap();
        if store.paused.remove(name).is_some() {
            save_paused(&store);
        }
        store.last_activity.insert(name.to_string(), now_secs());
    }

    fn touch_activity(&self, name: &str) {
        self.store.lock().unwrap().last_activity.insert(name.to_string(), now_secs());
    }

    /// Guard for ident-based endpoints (exec / agent command / terminal):
    /// alive → pass through; platform-paused → transparently revive;
    /// anything else → clear error telling the user what to press.
    async fn ensure_running(&self, ident: &str) -> Result<String, ApiError> {
        let name = self.resolve_agent(ident).await?;
        let status = self.agent_state(&name).await;
        if status == "running" {
            self.touch_activity(&name);
            return Ok(name);
        }
        if status == "paused" {
            hostexec::ensure_session(&name).await
                .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            self.clear_paused(&name);
            return Ok(name);
        }
        Err(err(StatusCode::BAD_REQUEST, format!("Agent is not running (status: {status}) — press Start or Resume")))
    }

    async fn exec_in(&self, agent: &str, command: &str) -> Result<(i64, String), ApiError> {
        self.exec_in_env(agent, command, Vec::new()).await
    }

    /// exec_in with extra environment variables — the only safe way to pass
    /// secrets (tokens, git identity) into an agent's command: they ride the
    /// 0600 script file (or the headless process env), never the command
    /// string, `ps` output or logs.
    async fn exec_in_env(&self, agent: &str, command: &str, env: Vec<String>) -> Result<(i64, String), ApiError> {
        hostexec::run(agent, command, &env)
            .await
            .map_err(|e| err(StatusCode::BAD_GATEWAY, e))
    }

    /// Make sure the project repo is checked out in the shared workspace at
    /// <workspace>/<repo-name> — the "bot on this machine" rule: every command
    /// runs on the host, the repo is cloned once before any work, and all
    /// file changes go through this working tree only. Idempotent: an
    /// existing clone is left untouched (it may hold the agent's work in
    /// progress). Returns the working-tree path.
    async fn ensure_repo(&self, agent: &str, repo_url: &str) -> Result<String, ApiError> {
        let repo_url = repo_url.trim().trim_end_matches(".git");
        if repo_url.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "Project has no repo URL configured"));
        }
        // the URL is interpolated into a quoted sh script — refuse anything exotic
        if repo_url.contains(['\'', '"', ' ', '\n', '\t', ';', '&', '|', '<', '>', '$', '`']) {
            return Err(err(StatusCode::BAD_REQUEST, format!("Invalid repo URL: {repo_url:?}")));
        }
        let dir = repo_dir_name(repo_url);
        let ws = hostexec::workspace_str();
        let path = format!("{ws}/{dir}");
        // private repos: the configured platform token rides the clone URL for
        // the INITIAL clone only (x-access-token is what GitHub PATs
        // authenticate as over HTTPS) — read access, never a per-machine
        // identity. The token never appears in error text — errors quote the
        // clean URL — and the origin URL is normalized back to the clean form
        // right after, so later fetch/push authenticate as the machine's own
        // gh credential helper, not as the platform token.
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
            "command -v git >/dev/null 2>&1 || {{ echo 'git is not installed on this machine'; exit 3; }}; \
             if [ ! -d '{path}/.git' ]; then git clone --depth 1 '{clone_url}' '{path}' || exit 4; else echo 'repo already cloned at {path}'; fi; \
             origin=$(git -C '{path}' remote get-url origin 2>/dev/null || true); \
             case \"$origin\" in *x-access-token:*) git -C '{path}' remote set-url origin '{repo_url}' >/dev/null 2>&1 || true;; esac"
        );
        let (code, out) = self.exec_in(agent, &script).await?;
        match code {
            0 => Ok(path),
            3 => Err(err(StatusCode::BAD_GATEWAY, "git is not installed on this machine — brew install git")),
            _ => {
                // git often echoes the remote URL, which carries the PAT.
                let safe_out = if git_token.is_empty() { out.clone() } else { out.replace(&git_token, "***") };
                Err(err(StatusCode::BAD_GATEWAY, format!("cloning {repo_url} into {path} failed (exit {code}): {safe_out}")))
            }
        }
    }

    /// Host-machine hygiene before an agent works (the platform never
    /// INSTALLS anything on the user's machine — the manifest probe right
    /// after reports what is really there): strip any legacy
    /// `x-access-token` insteadOf rewrite from the old shared-PAT era so
    /// push/pull go through the machine's own gh credential helper, and set a
    /// git identity ONLY when the user has none (their real config wins —
    /// commits carry the user's identity, per the one-machine-one-identity
    /// rule). Best-effort and silent.
    async fn ensure_tools(&self, agent: &str) {
        let script =
            "command -v git >/dev/null 2>&1 && { git config --global --get-regexp '^url\\..*\\.insteadof$' 2>/dev/null | while IFS=' ' read -r k _v; do case \"$k\" in *x-access-token*) git config --global --unset-all \"$k\" >/dev/null 2>&1 || true;; esac; done; true; }; \
             command -v git >/dev/null 2>&1 && { git config --global user.name >/dev/null 2>&1 || git config --global user.name 'AI Agent'; \
                 git config --global user.email >/dev/null 2>&1 || git config --global user.email 'agent@ai-agent-platform.local'; }; \
             exit 0";
        let _ = self.exec_in(agent, script).await;
    }

    /// Probe what is really installed on the machine (one exec: presence +
    /// version for every probed tool, plus gh's auth state) and render the
    /// tool-belt section for the system prompt: verified tools with versions,
    /// and — just as important — the probed tools that are MISSING, so the
    /// model never invents capabilities the machine doesn't have.
    async fn tools_manifest(&self, agent: &str) -> Option<String> {
        let probes = PROBED_TOOLS.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(" ");
        let script = format!(
            "for c in {probes}; do \
                 if command -v \"$c\" >/dev/null 2>&1; then \
                     v=$(\"$c\" --version 2>&1 | head -1); echo \"$c|$v\"; \
                 else echo \"$c|\"; fi; \
             done; \
             command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && echo 'gh_auth|1' || echo 'gh_auth|'"
        );
        let (code, out) = self.exec_in(agent, &script).await.ok()?;
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
            "\n\n## Your machine (macOS host) — tools verified as INSTALLED (use these; for anything else check `command -v <tool>` first)\n",
        );
        for (name, version, hint) in &have {
            let note = if name == "gh" && gh_authed {
                " — AUTHENTICATED: private GitHub repos and gh api/issue/pr commands all work"
            } else { "" };
            md.push_str(&format!("- `{name}` {version}{note} — {hint}\n"));
        }
        if !missing.is_empty() {
            let list = missing.iter().map(|m| format!("`{m}`")).collect::<Vec<_>>().join(", ");
            md.push_str(&format!("\nNOT installed on this machine — do NOT use or assume them: {list}\n"));
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
        self.llm_max_usage(model, system, user_text, max_tokens).await.map(|(text, _)| text)
    }

    /// Same call as `llm_max`, plus the provider-reported token usage so the
    /// caller can add it to the run's cost ledger.
    async fn llm_max_usage(&self, model: &str, system: &str, user_text: &str, max_tokens: u32) -> Result<(String, LlmUsage), ApiError> {
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

        // A provider that accepts the connection and then goes silent would
        // otherwise hang the step (and the whole run) forever.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("HTTP client init failed: {e}")))?;
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

        let usage = if template.protocol == "openai" {
            LlmUsage {
                input_tokens: data.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                output_tokens: data.pointer("/usage/completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            }
        } else {
            LlmUsage {
                input_tokens: data.pointer("/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                    + data.pointer("/usage/cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                    + data.pointer("/usage/cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                output_tokens: data.pointer("/usage/output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            }
        };

        // content arrives as a plain string or, on some OpenAI-compatible
        // servers, as an array of typed parts — accept both shapes
        let text = if template.protocol == "openai" {
            let content = data.pointer("/choices/0/message/content");
            content.and_then(|v| v.as_str()).map(str::to_string)
                .or_else(|| content.and_then(|v| v.as_array()).map(|parts| {
                    parts.iter()
                        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                        .collect::<String>()
                }))
                .unwrap_or_default()
        } else {
            data.get("content").and_then(|c| c.as_array()).map(|parts| {
                parts.iter()
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<String>()
            }).unwrap_or_default()
        };
        let text = text.trim().to_string();
        if !text.is_empty() { return Ok((text, usage)); }

        // 200 but no usable text — name the likely cause instead of a bare
        // empty string, so callers (llm_retry) and the UI can react to it
        let stop = if template.protocol == "openai" {
            data.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()).unwrap_or("")
        } else {
            data.get("stop_reason").and_then(|v| v.as_str()).unwrap_or("")
        };
        let reason = match stop {
            "length" | "max_tokens" => format!(
                "model '{model}' hit the {max_tokens}-token cap before writing any text (reasoning models spend the budget on thinking) — raise the limit or use a non-reasoning model"),
            "content_filter" => format!("model '{model}' filtered the answer (content_filter)"),
            _ => format!("model '{model}' returned an empty answer"),
        };
        Err(err(StatusCode::BAD_GATEWAY, reason))
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

async fn health(State(_app): State<App>) -> Json<Value> {
    Json(json!({ "status": "healthy", "mode": "host", "tmux": hostexec::tmux_available() }))
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

/// GET /containers — synthetic rows for host agents: the persisted registry
/// (every agent ever started) plus any live agent-* session not yet known.
/// `?all=true` is accepted and ignored (there is only one machine).
async fn list_containers(State(app): State<App>, headers: axum::http::HeaderMap, Query(_q): Query<ListQuery>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut names: Vec<String> = {
        let store = app.store.lock().unwrap();
        store.agents.iter().cloned().collect()
    };
    for s in hostexec::list_sessions().await {
        if s.starts_with("agent-") && !names.contains(&s) {
            names.push(s);
        }
    }
    names.sort();

    let (paused, last_activity) = {
        let store = app.store.lock().unwrap();
        (store.paused.clone(), store.last_activity.clone())
    };
    let now = now_secs();

    let mut rows = Vec::new();
    for name in names {
        let role = hostexec::role_of(&name).to_string();
        let alive = hostexec::session_alive(&name).await;
        // not alive + registered in paused.json = platform-paused (manual or idle sweeper)
        let paused_info = if alive { None } else { paused.get(&name) };
        let status = match paused_info {
            Some(_) => "paused",
            None if alive => "running",
            None => "exited",
        };
        let mut row = json!({
            "id": name,
            "name": name,
            "status": status,
            "image": "host",
            "labels": { "role": role },
        });
        if let Some(p) = paused_info {
            row["paused_since"] = json!(p.since);
            row["auto_paused"] = json!(p.auto);
        }
        if status == "running" {
            let last = last_activity.get(&name).copied().unwrap_or(now);
            row["idle_secs"] = json!(now.saturating_sub(last));
        }
        rows.push(row);
    }
    Ok(json_ok(Value::Array(rows)))
}

/// POST /containers — start a host agent: register it and ensure its tmux
/// session. Image/command fields are accepted and ignored (the "box" is this
/// machine with its real tools).
async fn create_container(State(app): State<App>, headers: axum::http::HeaderMap, Json(req): Json<ContainerCreate>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = req.name.trim().to_string();
    if name.is_empty() || req.role.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name and role are required"));
    }
    hostexec::ensure_session(&name)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    app.register_agent(&name);
    app.touch_activity(&name);
    Ok(json_ok(json!({
        "id": name,
        "name": name,
        "status": "running",
    })))
}

/// POST /containers/{ident}/{action} — lifecycle on tmux semantics:
/// start/resume = ensure the session; stop = kill it (user stop); pause =
/// kill it AND register as platform-paused; restart = kill + ensure.
async fn container_action(State(app): State<App>, headers: axum::http::HeaderMap, Path((ident, action)): Path<(String, String)>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    let action_status = |s: &str| json!({ "id": name, "name": name, "status": s });
    match action.as_str() {
        "start" | "resume" => {
            hostexec::ensure_session(&name).await
                .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            app.clear_paused(&name);
            Ok(json_ok(action_status("running")))
        }
        // A user stop must never keep rendering as platform-paused.
        "stop" => {
            hostexec::kill_session(&name).await;
            app.clear_paused(&name);
            Ok(json_ok(action_status("exited")))
        }
        "restart" => {
            hostexec::kill_session(&name).await;
            hostexec::ensure_session(&name).await
                .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            app.clear_paused(&name);
            Ok(json_ok(action_status("running")))
        }
        // Platform pause = kill the session + a registry entry so the UI can
        // tell it apart from a user stop (and the sweeper's transparent
        // revive still applies).
        "pause" => {
            hostexec::kill_session(&name).await;
            app.mark_paused(&name, false);
            Ok(json_ok(action_status("paused")))
        }
        other => Err(err(StatusCode::NOT_FOUND, format!("Unknown action '{other}'"))),
    }
}

/// DELETE /containers/{ident} — kill the session and unregister the agent.
/// The shared workspace is NEVER touched: deliverables and the cloned repo
/// outlive every agent.
async fn delete_container(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    hostexec::kill_session(&name).await;
    {
        let mut store = app.store.lock().unwrap();
        if store.paused.remove(&name).is_some() {
            save_paused(&store);
        }
        store.last_activity.remove(&name);
    }
    app.unregister_agent(&name);
    Ok(json_ok(json!({ "id": ident, "status": "deleted" })))
}

async fn exec_command(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, Json(req): Json<CommandRequest>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.ensure_running(&ident).await?;
    let (exit_code, output) = app.exec_in(&name, &req.command).await?;
    Ok(json_ok(json!({ "exit_code": exit_code, "output": output })))
}

// ---------------------------------------------------------------------------
// Interactive terminal — WebSocket ↔ host PTY, attached to the agent's tmux
// session through a private grouped session (windows are shared with the
// base session, so web terminals — several at once — and the user's own
// `tmux attach` all watch the same agent without fighting over it)
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
    let agent = match app.ensure_running(&ident).await {
        Ok(n) => n,
        Err(e) => return e.into_response(),
    };
    let initial = (params.cols.unwrap_or(80), params.rows.unwrap_or(24));
    ws.on_upgrade(move |socket| terminal_session(app, socket, agent, initial))
}

/// Bridge a browser terminal to a real PTY running the tmux attach. Binary
/// frames carry terminal bytes both ways; text frames are control messages
/// (`{"resize":{"cols":n,"rows":r}}`). Every browser frame counts as agent
/// activity so the idle sweeper leaves live sessions alone.
async fn terminal_session(app: App, mut socket: WebSocket, agent: String, (cols, rows): (u16, u16)) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("pty open failed: {e}\r\n").into())).await;
            return;
        }
    };

    let group = format!("aap-web-{}", app.seq.fetch_add(1, Ordering::SeqCst));
    let mut cmd = if hostexec::tmux_available() {
        if let Err(e) = hostexec::ensure_session(&agent).await {
            let _ = socket.send(Message::Text(format!("agent session unavailable: {e}\r\n").into())).await;
            return;
        }
        let mut cmd = CommandBuilder::new("tmux");
        for a in hostexec::attach_argv(&agent, &group) {
            cmd.arg(a);
        }
        cmd
    } else {
        // headless fallback — a plain shell in the shared workspace
        let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        cmd.cwd(hostexec::workspace_dir());
        cmd
    };
    cmd.env("TERM", "xterm-256color");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("failed to start attach: {e}\r\n").into())).await;
            return;
        }
    };
    drop(pair.slave);
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("pty reader failed: {e}\r\n").into())).await;
            return;
        }
    };
    let mut writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = socket.send(Message::Text(format!("pty writer failed: {e}\r\n").into())).await;
            return;
        }
    };

    // PTY → browser: blocking reads on a plain thread, forwarded over a channel
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (mut ws_tx, mut ws_rx) = socket.split();
    let pump = tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if ws_tx.send(Message::Binary(chunk.into())).await.is_err() {
                break;
            }
        }
        // attach exited — close the socket so the UI can offer reconnect
        let _ = ws_tx.send(Message::Close(None)).await;
    });

    // Browser → PTY
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Binary(data) => {
                app.touch_activity(&agent);
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            Message::Text(txt) => {
                if let Some(sz) = serde_json::from_str::<Value>(txt.as_str()).ok().and_then(|v| v.get("resize").cloned()) {
                    let c = sz.get("cols").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
                    let r = sz.get("rows").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
                    let _ = pair.master.resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    pump.abort();
    let _ = child.kill();
    hostexec::kill_session(&group).await;
}

// ---------------------------------------------------------------------------
// Handlers — stats / inspect / files
// ---------------------------------------------------------------------------

/// GET /containers/{ident}/stats — host agents have no per-cgroup numbers;
/// the honest equivalents: derived status (+paused overlay) and the shared
/// workspace's real disk usage. cpu/mem/net are null and the UI renders "—".
async fn container_stats(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;

    let ws = hostexec::workspace_str();
    let (disk_used, disk_total) = match app.exec_in(&name, &format!("df -P '{ws}' | tail -1")).await {
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

    // the detail page's stats poll uses this field to keep its status badge
    // in sync (sweeper, transparent revive)
    let status = app.agent_state(&name).await;
    let mut paused_since = Value::Null;
    let mut auto_paused = Value::Null;
    if status == "paused" {
        let store = app.store.lock().unwrap();
        if let Some(p) = store.paused.get(&name) {
            paused_since = json!(p.since);
            auto_paused = json!(p.auto);
        }
    }

    Ok(json_ok(json!({
        "cpu_percent": Value::Null,
        "mem_used": Value::Null,
        "mem_limit": Value::Null,
        "net_rx": Value::Null,
        "net_tx": Value::Null,
        "disk_used": disk_used,
        "disk_total": disk_total,
        "status": status,
        "paused_since": paused_since,
        "auto_paused": auto_paused,
    })))
}

/// GET /containers/{ident}/inspect — minimal synthetic view of a host agent.
async fn container_inspect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    let status = app.agent_state(&name).await;
    Ok(json_ok(json!({
        "id": name,
        "name": name,
        "image": "host",
        "created": "",
        "state": status,
        "started_at": "",
        "restart_policy": "no",
        "labels": { "role": hostexec::role_of(&name) },
        "networks": [],
    })))
}

#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default = "default_files_path")]
    path: String,
}

fn default_files_path() -> String { hostexec::workspace_str() }

async fn container_files(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, Query(q): Query<FilesQuery>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    let status = app.agent_state(&name).await;
    if status != "running" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Agent is not running (status: {status})")));
    }
    // q.path is user input — never interpolate it raw into a shell string.
    let cmd = format!("ls -la -- {} 2>&1 || ls -la -- {}", hostexec::shq(&q.path), hostexec::shq(&q.path));
    let (_, output) = app.exec_in(&name, &cmd).await?;
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
async fn connectors_catalog(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    Ok(json_ok(json!([
        {
            "type": "github",
            "name": "GitHub",
            "description": "gh CLI + git push/pull ใน container — ใช้ private repo, issue และ PR ได้จากในเครื่องนั้นโดยตรง (login แยกทีละเครื่อง — หลักคือ browser device flow, วาง token เป็นทางสำรอง)",
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
/// (no gh binary on the machine).
async fn github_connector_status(app: &App, name: &str) -> CachedConnectorStatus {
    let cache_key = format!("{name}:github");
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
    let (code, output) = match app.exec_in(name, "command -v gh >/dev/null 2>&1 || exit 127; gh auth status --hostname github.com").await {
        Ok(r) => r,
        Err(_) => (127, String::new()),
    };
    let status = if code == 127 {
        CachedConnectorStatus { state: "unavailable".into(), login: None, reason: Some("gh CLI not installed on this machine — brew install gh".into()), at: now_secs() }
    } else if code == 0 {
        CachedConnectorStatus { state: "connected".into(), login: parse_gh_login(&output), reason: None, at: now_secs() }
    } else {
        CachedConnectorStatus { state: "disconnected".into(), login: None, reason: None, at: now_secs() }
    };
    app.store.lock().unwrap().connector_cache.insert(cache_key, status.clone());
    status
}

/// Probe the machine's Figma connector state. Figma has no CLI whose login we
/// could ask about — the token file in the user's home IS the credential
/// store, so the probe is a single file check (plus the handle written next
/// to it at connect time).
async fn figma_connector_status(app: &App, name: &str) -> CachedConnectorStatus {
    let cache_key = format!("{name}:figma");
    {
        let store = app.store.lock().unwrap();
        if let Some(c) = store.connector_cache.get(&cache_key) {
            if now_secs().saturating_sub(c.at) < CONNECTOR_CACHE_TTL {
                return c.clone();
            }
        }
    }
    // 0 = token file present (stdout = saved handle); anything else = not
    // connected. An exec failure also lands in "disconnected" — the machine
    // is the source of truth and the next poll re-derives it.
    let (code, output) = match app.exec_in(name,
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

/// Current GitHub connector state for one agent. An active device flow wins
/// over the probe so a refreshed dialog can resume with its user code.
async fn github_state_json(app: &App, name: &str) -> Value {
    let pending = {
        let store = app.store.lock().unwrap();
        store.pending_device_flows.get(name)
            .filter(|f| f.expires_at > now_secs())
            .map(|f| json!({
                "type": "github", "state": "pending", "login": null, "reason": null,
                "user_code": f.user_code, "verification_url": f.verification_url,
            }))
    };
    match pending {
        Some(v) => v,
        None => connector_json("github", &github_connector_status(app, name).await),
    }
}

/// GET /containers/{ident}/connectors — per-connector state for one agent.
async fn container_connectors(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    Ok(json_ok(json!([
        github_state_json(&app, &name).await,
        connector_json("figma", &figma_connector_status(&app, &name).await),
    ])))
}

/// GET /connectors/status — every registered agent × its connector states,
/// for the connectors overview page.
async fn connectors_status(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    let mut names: Vec<String> = {
        let store = app.store.lock().unwrap();
        store.agents.iter().cloned().collect()
    };
    for s in hostexec::list_sessions().await {
        if s.starts_with("agent-") && !names.contains(&s) {
            names.push(s);
        }
    }
    names.sort();

    let mut rows = Vec::new();
    for name in names {
        let (github, figma) = (
            github_state_json(&app, &name).await,
            connector_json("figma", &figma_connector_status(&app, &name).await),
        );
        rows.push(json!({
            "id": name,
            "name": name,
            "status": app.agent_state(&name).await,
            "image": "host",
            "role": hostexec::role_of(&name),
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
    let name = app.resolve_agent(&ident).await?;

    // gh binary present on this machine?
    let (gh_ok, _) = app.exec_in(&name, "command -v gh >/dev/null 2>&1").await?;
    if gh_ok != 0 {
        return Err(err(StatusCode::BAD_REQUEST, "gh CLI not installed on this machine — brew install gh to connect GitHub"));
    }

    let (user_code, verification_url, expires_in) = start_github_device_flow(&app, &name).await?;
    Ok(json_ok(json!({ "user_code": user_code, "verification_url": verification_url, "expires_in": expires_in })))
}

/// Start (or resume) a GitHub device flow for a container: mint a device code
/// from GitHub, remember it as this container's pending flow, and spawn the
/// background poll that injects the token once the user approves. Pure flow
/// mechanics — callers gate on the container running and gh being installed
/// (their failure modes differ: HTTP 400 vs an honest stage skip). Idempotent:
/// an unexpired pending flow returns its code so a re-opened dialog (or a
/// re-run stage) resumes instead of minting a second flow.
/// Returns (user_code, verification_url, expires_in).
async fn start_github_device_flow(app: &App, container_id: &str) -> Result<(String, String, u64), ApiError> {
    let existing = {
        let store = app.store.lock().unwrap();
        store.pending_device_flows.get(container_id)
            .filter(|f| f.expires_at > now_secs())
            .map(|f| (f.user_code.clone(), f.verification_url.clone(), f.expires_at.saturating_sub(now_secs())))
    };
    if let Some((user_code, verification_url, expires_in)) = existing {
        return Ok((user_code, verification_url, expires_in));
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
        store.pending_device_flows.insert(container_id.to_string(), PendingDeviceFlow {
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
    let poll_id = container_id.to_string();
    tokio::spawn(async move { poll_github_device_flow(poll_app, poll_id).await });

    Ok((user_code, verification_url, expires_in))
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
    // The trailing block drops any platform-PAT `url.*.insteadOf` rewrite
    // (ensure_tools may have written one before this login existed) so gh's
    // credential helper governs github.com from here on. Keys are read from
    // gitconfig at runtime — the platform token is never in this command
    // string, and the connector token still rides only the exec ENV.
    let login_script = r#"printf %s "$GH_LOGIN_TOKEN" | gh auth login --with-token --hostname github.com && gh auth setup-git && git config --global user.name "$GIT_USER_NAME" && git config --global user.email "$GIT_USER_EMAIL" && { git config --global --get-regexp '^url\..*\.insteadof$' 2>/dev/null | while IFS=' ' read -r k _v; do case "$k" in *x-access-token*) git config --global --unset-all "$k" >/dev/null 2>&1 || true;; esac; done; true; }"#;
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
        // a completed login voids any pending device flow for this container —
        // a late approval must not re-inject a different account over this one
        store.pending_device_flows.remove(container_id);
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
/// credentials from this MACHINE (best-effort). One machine = one identity:
/// this logs the whole team out, which is exactly the per-machine semantics.
async fn github_disconnect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    // `gh auth logout` prompts for confirmation and aborts without a TTY —
    // pipe "y" AND remove the credential file directly so the logout is real
    // either way. Best-effort: the trailing `true` makes the exit code 0.
    let (_, output) = app.exec_in(&name,
        r#"printf 'y\n' | gh auth logout --hostname github.com 2>/dev/null; rm -f "$HOME/.config/gh/hosts.yml"; git config --global --unset credential.https://github.com.helper 2>/dev/null; true"#
    ).await?;
    {
        let mut store = app.store.lock().unwrap();
        // also drop any in-flight device flow: approving its code after a
        // disconnect must NOT silently re-login the machine
        store.pending_device_flows.remove(&name);
        store.connector_cache.remove(format!("{name}:github").as_str());
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
    let name = app.resolve_agent(&ident).await?;
    let (gh_ok, _) = app.exec_in(&name, "command -v gh >/dev/null 2>&1").await?;
    if gh_ok != 0 {
        return Err(err(StatusCode::BAD_REQUEST, "gh CLI not installed on this machine — brew install gh to connect GitHub"));
    }
    let token = body.token.trim();
    if token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Token is required"));
    }
    let login = inject_github_token(&app, &name, token).await?;
    Ok(json_ok(json!({ "type": "github", "state": "connected", "login": login })))
}

/// POST /containers/{ident}/connectors/figma/connect-token — Figma only has
/// one auth method here: a personal access token (Figma account → Settings →
/// Security → Personal access tokens). Validated against /v1/me, then written
/// into the user's real ~/.config/figma/token (+ FIGMA_TOKEN exported in the
/// shell profiles) so any shell or agent on the machine can call the REST
/// API. The token rides the exec script env — never the command string,
/// Store, or logs.
async fn figma_connect_token(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, axum::Json(body): axum::Json<TokenAuthBody>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
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
    let (code, _) = app.exec_in_env(&name, script, vec![
        format!("FIGMA_AUTH_TOKEN={token}"),
        format!("FIGMA_AUTH_USER={handle}"),
    ]).await?;

    let cache_key = format!("{name}:figma");
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
        Err(err(StatusCode::BAD_GATEWAY, "Failed to write the token onto this machine"))
    }
}

/// POST /containers/{ident}/connectors/figma/disconnect — remove the token
/// files and the profile exports (best-effort). BSD sed needs the explicit
/// empty backup suffix on macOS.
async fn figma_disconnect(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    let (_, output) = app.exec_in(&name,
        r#"rm -rf "$HOME/.config/figma"; sed -i '' '/FIGMA_TOKEN/d' "$HOME/.profile" "$HOME/.bashrc" 2>/dev/null; true"#
    ).await?;
    app.store.lock().unwrap().connector_cache.remove(format!("{name}:figma").as_str());
    Ok(json_ok(json!({ "type": "figma", "state": "disconnected", "output": output })))
}

/// POST /containers/{ident}/connectors/github/open-browser — open the device
/// verification URL in the user's REAL browser (macOS `open`), so the login
/// happens "on this machine" like the user wants.
async fn github_open_browser(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let name = app.resolve_agent(&ident).await?;
    // URL comes from the stored pending flow — never from client input
    let url = {
        let store = app.store.lock().unwrap();
        store.pending_device_flows.get(&name)
            .filter(|f| f.expires_at > now_secs())
            .map(|f| f.verification_url.clone())
    };
    let Some(url) = url else {
        return Err(err(StatusCode::BAD_REQUEST, "No active GitHub login flow — click Connect first"));
    };
    let (code, _) = app.exec_in(&name, &format!("command -v open >/dev/null 2>&1 || exit 127; open '{url}'")).await?;
    if code != 0 {
        return Err(err(StatusCode::BAD_REQUEST, "could not open the browser on this machine — open the URL manually instead"));
    }
    Ok(json_ok(json!({ "opened": true, "url": url })))
}

// ---------------------------------------------------------------------------
// Handlers — AI agent command (consult / execute)
// ---------------------------------------------------------------------------

async fn agent_command(State(app): State<App>, headers: axum::http::HeaderMap, Path(ident): Path<String>, Json(req): Json<CommandRequest>) -> ApiResult {
    app.require_auth(&headers)?;
    let agent = app.ensure_running(&ident).await?;

    let role_label = hostexec::role_of(&agent).to_string();
    let persona = app.store.lock().unwrap().personas.iter().find(|p| p.role == role_label).cloned();
    let base_prompt = persona.as_ref().map(|p| p.rules_md.clone())
        .unwrap_or_else(|| "You are a capable autonomous agent working in the user's macOS shell.".into());
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

    // Bot-on-this-machine rule: every command runs on the host, and the
    // project repo is cloned into the shared workspace BEFORE any work — then
    // all file/code work goes through that repo working tree only. First the
    // tool belt is probed, so the model is told what this machine really has
    // (and what it does NOT) instead of guessing.
    app.ensure_tools(&agent).await;
    let tools_md = app.tools_manifest(&agent).await.unwrap_or_default();
    let repo_url = app.repo_for_role(&role_label);
    let (repo_path, repo_warning) = if repo_url.is_empty() {
        (None, None)
    } else {
        match app.ensure_repo(&agent, &repo_url).await {
            Ok(path) => (Some(path), None),
            // one clone failure must not brick commands that don't touch the repo
            Err(e) => (None, Some(e.1)),
        }
    };

    let repo_rules = match &repo_path {
        Some(p) => format!(
            " The project repository is already cloned on this machine at {p} — it is your working directory. Run ALL file and code work through that repo working tree ONLY (never clone, copy or recreate it elsewhere)."
        ),
        None => String::new(),
    };
    // The project's document space, refreshed into the shared workspace — this
    // mode runs real bash, so the agent can open those files itself on demand.
    let docs_line = {
        let store = app.store.lock().unwrap();
        store.projects.iter().find(|p| p.agents.iter().any(|a| a == &role_label))
            .map(|p| prepare_project_docs(&store, &p.id).1)
            .unwrap_or_default()
    };
    let system = format!(
        "{base_prompt}\n\nYou are operating in the user's macOS shell (bash) on their Mac as an autonomous agent. The user gives a request in any language. Answer with EXACTLY ONE line containing ONE safe bash command that accomplishes the request using your expertise. Output the bare command only — no markdown, no backticks, no explanation. If the request is a question, answer it with a command that prints the answer (e.g. echo). Anything you launch with `open` (URLs, files) appears visibly on the user's screen.{tools_md}{repo_rules}{docs_line}"
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
    let (exit_code, output) = app.exec_in(&agent, &exec_command).await?;
    Ok(json_ok(json!({
        "mode": "execute", "role": role_label, "model": model, "reply": reply,
        "command": command, "exit_code": exit_code, "output": output,
        "repo": repo_path, "repo_warning": repo_warning,
    })))
}

// ---------------------------------------------------------------------------
// Handlers — personas (AI team, editable via UI with markdown rules)
// ---------------------------------------------------------------------------

async fn list_agents(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    let (personas, provider_id, default_model) = {
        let store = app.store.lock().unwrap();
        let pid = store.config.ai_provider.clone();
        let dm = provider_template(&pid).unwrap_or(&PROVIDERS[0]).model.to_string();
        (store.personas.clone(), pid, dm)
    };
    let mut running: HashMap<String, Value> = HashMap::new();
    {
        let registered: Vec<String> = app.store.lock().unwrap().agents.iter().cloned().collect();
        let mut names = registered;
        for s in hostexec::list_sessions().await {
            if s.starts_with("agent-") && !names.contains(&s) {
                names.push(s);
            }
        }
        for name in names {
            let role = hostexec::role_of(&name).to_string();
            if personas.iter().any(|p| p.role == role) {
                running.insert(role, json!({
                    "name": name,
                    "status": app.agent_state(&name).await,
                    "id": name,
                }));
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
            "reports_to": p.reports_to, "harness": p.harness, "harness_command": p.harness_command,
            "container": running.get(&p.role),
        })
    }).collect();
    Ok(json_ok(Value::Array(agents)))
}

async fn create_persona(State(app): State<App>, headers: axum::http::HeaderMap, Json(mut p): Json<Persona>) -> ApiResult {
    app.require_auth(&headers)?;
    p.role = p.role.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string();
    if p.role.is_empty() || p.name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "role and name are required"));
    }
    if !matches!(p.harness.as_str(), "native" | "claude" | "codex" | "custom") {
        return Err(err(StatusCode::BAD_REQUEST, "harness must be native, claude, codex or custom"));
    }
    if p.harness == "custom" && p.harness_command.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "custom harness needs a command template"));
    }
    if p.reports_to == p.role { p.reports_to.clear(); }
    let mut store = app.store.lock().unwrap();
    if !p.reports_to.is_empty() && !store.personas.iter().any(|x| x.role == p.reports_to) {
        return Err(err(StatusCode::BAD_REQUEST, format!("Unknown manager role '{}'", p.reports_to)));
    }
    if store.personas.iter().any(|x| x.role == p.role) {
        return Err(err(StatusCode::CONFLICT, format!("Persona '{}' already exists", p.role)));
    }
    store.personas.push(p.clone());
    save_personas(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(p).unwrap()))
}

async fn update_persona(State(app): State<App>, headers: axum::http::HeaderMap, Path(role): Path<String>, Json(req): Json<PersonaUpdate>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let provider_id = store.config.ai_provider.clone();
    // Validate the harness transition against the FINAL state before mutating.
    let current = store.personas.iter().find(|p| p.role == role)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Persona '{role}' not found")))?;
    let next_harness = req.harness.clone().unwrap_or_else(|| current.harness.clone());
    let next_command = req.harness_command.as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| current.harness_command.clone());
    if !matches!(next_harness.as_str(), "native" | "claude" | "codex" | "custom") {
        return Err(err(StatusCode::BAD_REQUEST, "harness must be native, claude, codex or custom"));
    }
    if next_harness == "custom" && next_command.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "custom harness needs a command template"));
    }
    let p = store.personas.iter_mut().find(|p| p.role == role)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Persona '{role}' not found")))?;
    if let Some(v) = req.name { if !v.is_empty() { p.name = v; } }
    if let Some(v) = req.title { p.title = v; }
    if let Some(v) = req.years { p.years = v; }
    if let Some(v) = req.expertise { p.expertise = v; }
    if let Some(v) = req.rules_md { p.rules_md = v; }
    if let Some(v) = req.reports_to {
        p.reports_to = if v == role { String::new() } else { v };
    }
    if let Some(v) = req.harness { p.harness = v; }
    if let Some(v) = req.harness_command { p.harness_command = v.trim().to_string(); }
    if let Some(v) = req.model {
        // unlike the other fields, an empty string here MEANS "clear the override"
        let v = v.trim().to_string();
        if v.is_empty() { p.model_overrides.remove(&provider_id); }
        else { p.model_overrides.insert(provider_id, v); }
    }
    let out = p.clone();
    save_personas(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_persona(State(app): State<App>, headers: axum::http::HeaderMap, Path(role): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let len = store.personas.len();
    store.personas.retain(|p| p.role != role);
    if store.personas.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Persona '{role}' not found")));
    }
    save_personas(&store);
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
    let name = body.map(|Json(b)| b.name).flatten().unwrap_or_else(|| hostexec::session_name(&role));
    // ensure the session (reviving a paused/stopped agent transparently),
    // register it, done — idempotent, no 409-equivalent to dance around.
    hostexec::ensure_session(&name)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    app.register_agent(&name);
    app.clear_paused(&name);
    app.touch_activity(&name);
    Ok(json_ok(json!({ "id": name, "name": name, "status": "running" })))
}

// ---------------------------------------------------------------------------
// Handlers — tasks
// ---------------------------------------------------------------------------

async fn list_tasks(State(app): State<App>, headers: axum::http::HeaderMap) -> Result<Json<Vec<Task>>, ApiError> {
    app.require_auth(&headers)?;
    Ok(Json(app.store.lock().unwrap().tasks.clone()))
}

async fn create_task(State(app): State<App>, headers: axum::http::HeaderMap, Json(req): Json<TaskCreate>) -> ApiResult {
    app.require_auth(&headers)?;
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
    save_tasks(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(task).unwrap()))
}

async fn delete_task(State(app): State<App>, headers: axum::http::HeaderMap, Path(task_id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let len = store.tasks.len();
    store.tasks.retain(|t| t.id != task_id);
    if store.tasks.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Task '{task_id}' not found")));
    }
    save_tasks(&store);
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
        "auto_pause_enabled": cfg.auto_pause_enabled,
        "idle_timeout_secs": cfg.idle_timeout_secs,
        "pricing": cfg.pricing,
        "default_input_per_mtok": cfg.default_input_per_mtok,
        "default_output_per_mtok": cfg.default_output_per_mtok,
        "auth_required": auth_enabled(),
    })
}

async fn get_config(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    Ok(json_ok(config_json(&app.store.lock().unwrap().config)))
}

async fn update_config(State(app): State<App>, headers: axum::http::HeaderMap, Json(req): Json<ConfigUpdate>) -> ApiResult {
    app.require_auth(&headers)?;
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
        if let Some(v) = req.auto_pause_enabled { cfg.auto_pause_enabled = v; }
        if let Some(v) = req.idle_timeout_secs { cfg.idle_timeout_secs = v.max(60); }
        if let Some(v) = req.pricing {
            cfg.pricing = v.into_iter()
                .filter(|(k, _)| !k.trim().is_empty())
                .map(|(k, p)| (k, ModelPrice {
                    input_per_mtok: p.input_per_mtok.max(0.0),
                    output_per_mtok: p.output_per_mtok.max(0.0),
                }))
                .collect();
        }
        if let Some(v) = req.default_input_per_mtok { cfg.default_input_per_mtok = v.max(0.0); }
        if let Some(v) = req.default_output_per_mtok { cfg.default_output_per_mtok = v.max(0.0); }
        save_config(&store);
    }
    let cfg = app.store.lock().unwrap().config.clone();
    Ok(json_ok(config_json(&cfg)))
}

async fn list_skills(State(app): State<App>, headers: axum::http::HeaderMap) -> Result<Json<Vec<Skill>>, ApiError> {
    app.require_auth(&headers)?;
    Ok(Json(app.store.lock().unwrap().skills.clone()))
}

async fn create_skill(State(app): State<App>, headers: axum::http::HeaderMap, Json(req): Json<SkillCreate>) -> ApiResult {
    app.require_auth(&headers)?;
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
    let skill = Skill {
        id, name: req.name, description: req.description, enabled: true,
        version: 1, test_inputs: Vec::new(), test_runs: Vec::new(), history: Vec::new(),
    };
    store.skills.push(skill.clone());
    save_skills(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(skill).unwrap()))
}

async fn update_skill(State(app): State<App>, headers: axum::http::HeaderMap, Path(skill_id): Path<String>, Json(req): Json<SkillUpdate>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let skill = store.skills.iter_mut().find(|s| s.id == skill_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")))?;
    let old = (skill.name.clone(), skill.description.clone(), skill.enabled);
    if let Some(name) = req.name.as_deref() {
        let name = name.trim();
        if name.is_empty() { return Err(err(StatusCode::BAD_REQUEST, "name cannot be empty")); }
        skill.name = name.to_string();
    }
    if let Some(desc) = req.description.as_deref() {
        skill.description = desc.to_string();
    }
    if let Some(enabled) = req.enabled {
        skill.enabled = enabled;
    }
    if old != (skill.name.clone(), skill.description.clone(), skill.enabled) {
        // Keep the previous version so the history is auditable.
        skill.history.insert(0, SkillSnapshot {
            version: skill.version,
            name: old.0,
            description: old.1,
            enabled: old.2,
            at: now_secs(),
        });
        skill.history.truncate(20);
        skill.version += 1;
    }
    let out = skill.clone();
    save_skills(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

/// Restore a previous snapshot; the current state is snapshotted first so the
/// restore itself is undoable.
async fn restore_skill(State(app): State<App>, headers: axum::http::HeaderMap, Path((skill_id, version)): Path<(String, u32)>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let skill = store.skills.iter_mut().find(|s| s.id == skill_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")))?;
    let snap = skill.history.iter().find(|h| h.version == version).cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Version {version} not found for skill '{skill_id}'")))?;
    skill.history.insert(0, SkillSnapshot {
        version: skill.version,
        name: skill.name.clone(),
        description: skill.description.clone(),
        enabled: skill.enabled,
        at: now_secs(),
    });
    skill.history.truncate(20);
    skill.version += 1;
    skill.name = snap.name;
    skill.description = snap.description;
    skill.enabled = snap.enabled;
    let out = skill.clone();
    save_skills(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

/// Save the Skill Studio test bench inputs (trimmed, non-empty, max 20).
async fn set_skill_tests(State(app): State<App>, headers: axum::http::HeaderMap, Path(skill_id): Path<String>, Json(req): Json<SkillTestsInput>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let skill = store.skills.iter_mut().find(|s| s.id == skill_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")))?;
    skill.test_inputs = req.inputs.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(20)
        .collect();
    let out = skill.clone();
    save_skills(&store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

/// Run the skill against its saved inputs (or a provided set) and keep the
/// newest 20 results. These are real provider calls, priced per token.
async fn run_skill_tests(
    State(app): State<App>, headers: axum::http::HeaderMap,
    Path(skill_id): Path<String>, Json(req): Json<SkillRunRequest>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let (skill, model) = {
        let store = app.store.lock().unwrap();
        let skill = store.skills.iter().find(|s| s.id == skill_id).cloned()
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")))?;
        let model = req.model.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| app.provider_default_model());
        (skill, model)
    };
    if model.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "No model configured — set one in AI Config"));
    }
    let inputs: Vec<String> = req.inputs.unwrap_or_else(|| skill.test_inputs.clone())
        .into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).take(10).collect();
    if inputs.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Save at least one test input first"));
    }
    let system = format!(
        "You are the reusable skill '{}'. {}\n\nApply this skill to the user's input. Reply with the result only — no preamble.",
        skill.name, skill.description
    );
    let (ip, op, _) = model_price(&app, &model);
    let mut new_runs = Vec::new();
    for input in inputs {
        let (output, cost) = match app.llm_max_usage(&model, &system, &input, 800).await {
            Ok((text, usage)) => (text, usage_cost(usage, ip, op)),
            Err(e) => (format!("⚠️ {}", e.1), 0.0),
        };
        new_runs.push(SkillTestRun {
            id: format!("st-{}", app.seq.fetch_add(1, Ordering::SeqCst)),
            input,
            output,
            model: model.clone(),
            at: now_secs(),
            cost_usd: cost,
        });
    }
    let mut store = app.store.lock().unwrap();
    let skill = store.skills.iter_mut().find(|s| s.id == skill_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")))?;
    new_runs.extend(skill.test_runs.clone());
    skill.test_runs = new_runs.into_iter().take(20).collect();
    let out = skill.clone();
    save_skills(&store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_skill(State(app): State<App>, headers: axum::http::HeaderMap, Path(skill_id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let len = store.skills.len();
    store.skills.retain(|s| s.id != skill_id);
    if store.skills.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Skill '{skill_id}' not found")));
    }
    save_skills(&store);
    Ok(json_ok(json!({ "deleted": skill_id })))
}

// ---------------------------------------------------------------------------
// Handlers — projects (team builder with react flow graphs)
// ---------------------------------------------------------------------------

async fn list_projects(State(app): State<App>, headers: axum::http::HeaderMap) -> Result<Json<Vec<Project>>, ApiError> {
    app.require_auth(&headers)?;
    Ok(Json(app.store.lock().unwrap().projects.clone()))
}

async fn create_project(State(app): State<App>, headers: axum::http::HeaderMap, Json(req): Json<ProjectCreate>) -> ApiResult {
    app.require_auth(&headers)?;
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
        goal: req.goal,
        budget_usd: req.budget_usd.filter(|b| *b > 0.0),
        budget_alert_pct: 80,
    };
    store.projects.push(project.clone());
    save_projects(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(project).unwrap()))
}

async fn get_project(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let store = app.store.lock().unwrap();
    let p = store.projects.iter().find(|p| p.id == id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")))?;
    Ok(json_ok(serde_json::to_value(p).unwrap()))
}

async fn update_project(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>, Json(req): Json<ProjectUpdate>) -> ApiResult {
    app.require_auth(&headers)?;
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
    if let Some(v) = req.goal { p.goal = v; }
    if let Some(v) = req.budget_usd { p.budget_usd = v.filter(|b| *b > 0.0); }
    if let Some(v) = req.budget_alert_pct { p.budget_alert_pct = v.clamp(1, 100); }
    let out = p.clone();
    save_projects(&store);
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_project(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let len = store.projects.len();
    store.projects.retain(|p| p.id != id);
    if store.projects.len() == len {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
    }
    // Runs of the deleted project are KEPT — they are the agents' work history
    // (agent detail shows them across projects, and /data/runs.json persists them).
    // The document space is NOT: it dies with its project (rows, uploaded files
    // and the materialized workspace copies all go).
    let doc_ids: Vec<String> = store.docs.iter().filter(|d| d.project_id == id).map(|d| d.id.clone()).collect();
    store.docs.retain(|d| d.project_id != id);
    for did in &doc_ids {
        let _ = std::fs::remove_dir_all(docs_files_dir().join(did));
    }
    let _ = std::fs::remove_dir_all(docs_workspace_dir(&id));
    save_projects(&store);
    save_docs(&store);
    Ok(json_ok(json!({ "deleted": id })))
}

// ---------------------------------------------------------------------------
// Handlers — project docs (the per-project document space)
// ---------------------------------------------------------------------------

/// docs of one project, sorted folder asc then newest-updated first
fn project_docs_sorted(store: &Store, project_id: &str) -> Vec<ProjectDoc> {
    let mut docs: Vec<ProjectDoc> = store.docs.iter().filter(|d| d.project_id == project_id).cloned().collect();
    docs.sort_by(|a, b| a.folder.cmp(&b.folder).then(b.updated_at.cmp(&a.updated_at)));
    docs
}

async fn list_docs(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let (docs, open_counts) = {
        let store = app.store.lock().unwrap();
        if !store.projects.iter().any(|p| p.id == id) {
            return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
        }
        let mut counts: HashMap<String, usize> = HashMap::new();
        for c in store.doc_comments.iter().filter(|c| c.project_id == id && c.status == "open") {
            *counts.entry(c.doc_id.clone()).or_default() += 1;
        }
        (project_docs_sorted(&store, &id), counts)
    };
    let out: Vec<Value> = docs.iter().map(|d| {
        let mut v = serde_json::to_value(d).unwrap_or_else(|_| json!({}));
        v["open_comments"] = json!(open_counts.get(&d.id).copied().unwrap_or(0));
        v
    }).collect();
    Ok(json_ok(json!(out)))
}

async fn create_doc(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>, Json(req): Json<DocCreate>) -> ApiResult {
    app.require_auth(&headers)?;
    if req.title.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Document title is required"));
    }
    let mut store = app.store.lock().unwrap();
    if !store.projects.iter().any(|p| p.id == id) {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
    }
    store.doc_counter += 1;
    let now = now_secs();
    let doc = ProjectDoc {
        id: format!("d-{:03}", store.doc_counter),
        project_id: id,
        folder: if req.folder.trim().is_empty() { "General".into() } else { req.folder.trim().to_string() },
        title: req.title.trim().to_string(),
        content_md: req.content_md,
        file: None,
        created_at: now,
        updated_at: now,
    };
    store.docs.push(doc.clone());
    save_docs(&store);
    materialize_project_docs(&store, &doc.project_id);
    drop(store);
    Ok(json_ok(serde_json::to_value(doc).unwrap()))
}

async fn get_doc(State(app): State<App>, headers: axum::http::HeaderMap, Path((id, doc_id)): Path<(String, String)>, Query(q): Query<DocQuery>) -> ApiResult {
    app.require_auth(&headers)?;
    let doc = {
        let store = app.store.lock().unwrap();
        if !store.projects.iter().any(|p| p.id == id) {
            return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
        }
        store.docs.iter().find(|d| d.id == doc_id && d.project_id == id).cloned()
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Document '{doc_id}' not found")))?
    };
    if q.raw.as_deref() != Some("1") {
        return Ok(json_ok(serde_json::to_value(&doc).unwrap()));
    }
    // Raw download — auth is a header, so the web always blob-fetches this.
    match &doc.file {
        Some(f) => {
            let path = docs_files_dir().join(&doc.id).join(&f.name);
            let bytes = std::fs::read(&path)
                .map_err(|_| err(StatusCode::NOT_FOUND, format!("File for document '{doc_id}' is missing on disk")))?;
            Ok(Response::builder()
                .header(header::CONTENT_TYPE, f.content_type.clone())
                .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", safe_doc_name(&f.name)))
                .header(header::CONTENT_LENGTH, bytes.len())
                .body(axum::body::Body::from(bytes))
                .unwrap())
        }
        None => {
            let body = doc.content_md.into_bytes();
            Ok(Response::builder()
                .header(header::CONTENT_TYPE, "text/markdown; charset=utf-8")
                .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}.md\"", safe_doc_name(&doc.title)))
                .header(header::CONTENT_LENGTH, body.len())
                .body(axum::body::Body::from(body))
                .unwrap())
        }
    }
}

async fn update_doc(State(app): State<App>, headers: axum::http::HeaderMap, Path((id, doc_id)): Path<(String, String)>, Json(req): Json<DocUpdate>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    if !store.projects.iter().any(|p| p.id == id) {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
    }
    let doc = store.docs.iter_mut().find(|d| d.id == doc_id && d.project_id == id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Document '{doc_id}' not found")))?;
    if let Some(v) = req.title { if !v.trim().is_empty() { doc.title = v.trim().to_string(); } }
    if let Some(v) = req.folder { if !v.trim().is_empty() { doc.folder = v.trim().to_string(); } }
    // Uploaded binaries are immutable — only the markdown body is editable.
    if doc.file.is_none() {
        if let Some(v) = req.content_md { doc.content_md = v; }
    }
    doc.updated_at = now_secs();
    let out = doc.clone();
    save_docs(&store);
    materialize_project_docs(&store, &id);
    drop(store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_doc(State(app): State<App>, headers: axum::http::HeaderMap, Path((id, doc_id)): Path<(String, String)>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    if !store.projects.iter().any(|p| p.id == id) {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
    }
    let before = store.docs.len();
    store.docs.retain(|d| !(d.id == doc_id && d.project_id == id));
    if store.docs.len() == before {
        return Err(err(StatusCode::NOT_FOUND, format!("Document '{doc_id}' not found")));
    }
    store.doc_comments.retain(|c| !(c.doc_id == doc_id && c.project_id == id));
    let _ = std::fs::remove_dir_all(docs_files_dir().join(&doc_id));
    save_docs(&store);
    materialize_project_docs(&store, &id);
    drop(store);
    Ok(json_ok(json!({ "deleted": doc_id })))
}

/// Inline comments anchored to a document passage. Open comments are injected
/// into every relay prompt so the team actually addresses them.
async fn list_doc_comments(
    State(app): State<App>, headers: axum::http::HeaderMap,
    Path((project_id, doc_id)): Path<(String, String)>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let store = app.store.lock().unwrap();
    let comments: Vec<DocComment> = store.doc_comments.iter()
        .filter(|c| c.project_id == project_id && c.doc_id == doc_id)
        .cloned().collect();
    Ok(json_ok(json!(comments)))
}

async fn create_doc_comment(
    State(app): State<App>, headers: axum::http::HeaderMap,
    Path((project_id, doc_id)): Path<(String, String)>,
    Json(req): Json<DocCommentCreate>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let body = req.body.trim().to_string();
    if body.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "comment body is required"));
    }
    let mut store = app.store.lock().unwrap();
    if !store.docs.iter().any(|d| d.id == doc_id && d.project_id == project_id) {
        return Err(err(StatusCode::NOT_FOUND, format!("Document '{doc_id}' not found")));
    }
    store.comment_counter += 1;
    let comment = DocComment {
        id: format!("c-{:03}", store.comment_counter),
        project_id,
        doc_id,
        author: if req.author.trim().is_empty() { "you".into() } else { req.author.trim().to_string() },
        quote: req.quote.trim().chars().take(400).collect(),
        body: body.chars().take(4000).collect(),
        status: "open".into(),
        created_at: now_secs(),
        resolved_at: 0,
    };
    let out = comment.clone();
    store.doc_comments.push(comment);
    save_docs(&store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn update_doc_comment(
    State(app): State<App>, headers: axum::http::HeaderMap,
    Path((project_id, doc_id, comment_id)): Path<(String, String, String)>,
    Json(req): Json<DocCommentUpdate>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let status = req.status.trim().to_lowercase();
    if status != "open" && status != "resolved" {
        return Err(err(StatusCode::BAD_REQUEST, "status must be 'open' or 'resolved'"));
    }
    let mut store = app.store.lock().unwrap();
    let comment = store.doc_comments.iter_mut()
        .find(|c| c.id == comment_id && c.doc_id == doc_id && c.project_id == project_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Comment '{comment_id}' not found")))?;
    comment.status = status.clone();
    comment.resolved_at = if status == "resolved" { now_secs() } else { 0 };
    let out = comment.clone();
    save_docs(&store);
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

async fn delete_doc_comment(
    State(app): State<App>, headers: axum::http::HeaderMap,
    Path((project_id, doc_id, comment_id)): Path<(String, String, String)>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let before = store.doc_comments.len();
    store.doc_comments.retain(|c| !(c.id == comment_id && c.doc_id == doc_id && c.project_id == project_id));
    if store.doc_comments.len() == before {
        return Err(err(StatusCode::NOT_FOUND, format!("Comment '{comment_id}' not found")));
    }
    save_docs(&store);
    Ok(json_ok(json!({ "deleted": comment_id })))
}

/// Multipart upload — `folder` (optional text field) + one `file` field.
/// .md/.markdown/.txt land as editable markdown docs (AI-injectable content);
/// everything else is stored as a binary attachment on disk.
async fn upload_doc(State(app): State<App>, headers: axum::http::HeaderMap, Path(id): Path<String>, mut multipart: Multipart) -> ApiResult {
    app.require_auth(&headers)?;
    {
        let store = app.store.lock().unwrap();
        if !store.projects.iter().any(|p| p.id == id) {
            return Err(err(StatusCode::NOT_FOUND, format!("Project '{id}' not found")));
        }
    }

    let mut folder = String::new();
    let mut file_field: Option<(String, String, Vec<u8>)> = None; // (name, content_type, bytes)
    while let Some(field) = multipart.next_field().await
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("Bad upload: {e}")))? {
        match field.name().unwrap_or("") {
            "folder" => {
                folder = field.text().await.unwrap_or_default().trim().to_string();
            }
            _ => {
                let Some(fname) = field.file_name().map(|s| s.to_string()) else { continue };
                let ctype = field.content_type().unwrap_or("application/octet-stream").to_string();
                let bytes = field.bytes().await
                    .map_err(|e| err(StatusCode::BAD_REQUEST, format!("Could not read upload: {e}")))?;
                if bytes.is_empty() {
                    return Err(err(StatusCode::BAD_REQUEST, "Uploaded file is empty"));
                }
                if bytes.len() > DOC_UPLOAD_MAX_BYTES {
                    return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "File too large (max 25 MB)"));
                }
                file_field = Some((fname, ctype, bytes.to_vec()));
            }
        }
    }
    let Some((fname, ctype, bytes)) = file_field else {
        return Err(err(StatusCode::BAD_REQUEST, "No file in upload"));
    };

    let ext = std::path::Path::new(&fname).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let is_text = matches!(ext.as_str(), "md" | "markdown" | "txt");
    let title = std::path::Path::new(&fname).file_stem().and_then(|s| s.to_str()).unwrap_or("document").to_string();

    let mut store = app.store.lock().unwrap();
    store.doc_counter += 1;
    let now = now_secs();
    let mut doc = ProjectDoc {
        id: format!("d-{:03}", store.doc_counter),
        project_id: id,
        folder: if folder.is_empty() { "General".into() } else { folder },
        title,
        content_md: String::new(),
        file: None,
        created_at: now,
        updated_at: now,
    };
    if is_text {
        doc.content_md = String::from_utf8_lossy(&bytes).into_owned();
    } else {
        let safe = safe_doc_name(&fname);
        let dir = docs_files_dir().join(&doc.id);
        if std::fs::create_dir_all(&dir).is_err() {
            return Err(err(StatusCode::INTERNAL_SERVER_ERROR, "Could not store the uploaded file"));
        }
        if std::fs::write(dir.join(&safe), &bytes).is_err() {
            return Err(err(StatusCode::INTERNAL_SERVER_ERROR, "Could not store the uploaded file"));
        }
        doc.file = Some(DocFile { name: safe, content_type: ctype, size: bytes.len() as u64 });
    }
    store.docs.push(doc.clone());
    save_docs(&store);
    materialize_project_docs(&store, &doc.project_id);
    drop(store);
    Ok(json_ok(serde_json::to_value(doc).unwrap()))
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

pub(crate) fn data_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("DATA_DIR") {
        if !d.trim().is_empty() { return std::path::PathBuf::from(d); }
    }
    let preferred = std::path::Path::new("/data");
    if preferred.is_dir() { preferred.to_path_buf() } else { std::path::PathBuf::from("./data") }
}

fn runs_file() -> std::path::PathBuf {
    data_dir().join("runs.json")
}

/// Repair permissions left by older builds: the data dir holds sessions,
/// tokens and API keys, so it must be 0700 and every store file 0600 — an
/// upgrade should not leave a world-readable config.json behind.
fn harden_data_dir() {
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_file() { continue; }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") || name.ends_with(".json.tmp") {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

/// Create files 0600 (never a world-readable window) and fsync the file + its
/// directory before returning, so a crash cannot leave a truncated or
/// plainly-readable store behind. The tmp name is unique per process.
fn write_atomic_private(path: &std::path::Path, payload: &str) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "data.json".into());
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let mut file = {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&tmp)?
    };
    file.write_all(payload.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
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
    // Best effort: platform keeps working in memory even when the disk write fails.
    if let Err(e) = write_atomic_private(&runs_file(), &payload) {
        eprintln!("warning: could not persist runs: {e}");
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
    let mut dirty = false;
    for run in runs.iter_mut() {
        if run.status == "running" || run.status == "waiting_human" {
            dirty = true;
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
        // A closed run (whatever closed it — restart, Stop, an older build with
        // the finish gap) must not carry steps stuck at "working": nobody will
        // ever advance them, and the UI would show a busy spinner forever.
        for step in run.steps.iter_mut().filter(|s| s.status == "working") {
            dirty = true;
            step.status = "stopped".into();
            step.output = "stopped mid-work — the run already ended while this step was in flight".into();
            if step.finished_at == 0 { step.finished_at = now; }
        }
        run.stop_requested = false;
    }
    let max_id = runs.iter()
        .filter_map(|r| r.id.strip_prefix("run-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.run_counter = store.run_counter.max(parsed.run_counter).max(max_id);
    // Runs outlive projects (they ARE the work history), so a fresh boot must
    // not hand out a p-NNN id that a restored run still references — the board
    // would graft that orphan history onto the brand-new project.
    let max_pid = runs.iter()
        .filter_map(|r| r.project_id.strip_prefix("p-").and_then(|n| n.parse::<usize>().ok()))
        .chain(store.projects.iter().filter_map(|p| p.id.strip_prefix("p-").and_then(|n| n.parse::<usize>().ok())))
        .max().unwrap_or(0);
    store.project_counter = store.project_counter.max(max_pid);
    println!("restored {} run(s) from {}", runs.len(), runs_file().display());
    store.runs = runs;
    if dirty {
        // Persist the restart cleanup — otherwise every boot re-closes (and
        // re-notifies) the same runs until the file is written by something else.
        save_runs(store);
    }
}

// ---------------------------------------------------------------------------
// Projects persistence — /data/projects.json. Until now projects were seeded
// fresh every boot; the document space made persistence mandatory (docs would
// otherwise dangle on a restarted store), and the team builder benefits too.
// ---------------------------------------------------------------------------

fn projects_file() -> std::path::PathBuf {
    data_dir().join("projects.json")
}

fn save_projects(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> {
        projects: &'a [Project],
        project_counter: usize,
    }
    let payload = match serde_json::to_string_pretty(&Persisted { projects: &store.projects, project_counter: store.project_counter }) {
        Ok(p) => p,
        Err(_) => return,
    };
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = projects_file();
    let tmp = dir.join("projects.json.tmp");
    if std::fs::write(&tmp, payload).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        eprintln!("warning: could not persist projects to {}", path.display());
    }
}

/// Restore projects at boot. A missing/unreadable file keeps the seeded store
/// (same behavior as before persistence existed). On success the seed project
/// is replaced by what was persisted.
fn load_projects(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted {
        #[serde(default)]
        projects: Vec<Project>,
        #[serde(default)]
        project_counter: usize,
    }
    let Ok(raw) = std::fs::read_to_string(projects_file()) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: {} is unreadable — keeping the seeded projects", projects_file().display());
        return;
    };
    let max_id = parsed.projects.iter()
        .filter_map(|p| p.id.strip_prefix("p-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.project_counter = store.project_counter.max(parsed.project_counter).max(max_id);
    println!("restored {} project(s) from {}", parsed.projects.len(), projects_file().display());
    store.projects = parsed.projects;
}

// ---------------------------------------------------------------------------
// Docs persistence — the document space survives restarts as /data/docs.json
// (markdown inline; uploaded binaries live under <data>/docs-files/<doc_id>/).
// ---------------------------------------------------------------------------

fn docs_file() -> std::path::PathBuf {
    data_dir().join("docs.json")
}

fn docs_files_dir() -> std::path::PathBuf {
    data_dir().join("docs-files")
}

fn save_docs(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> {
        docs: &'a [ProjectDoc],
        doc_counter: usize,
        comments: &'a [DocComment],
        comment_counter: usize,
    }
    let payload = match serde_json::to_string_pretty(&Persisted {
        docs: &store.docs, doc_counter: store.doc_counter,
        comments: &store.doc_comments, comment_counter: store.comment_counter,
    }) {
        Ok(p) => p,
        Err(_) => return,
    };
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = docs_file();
    let tmp = dir.join("docs.json.tmp");
    if std::fs::write(&tmp, payload).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        eprintln!("warning: could not persist docs to {}", path.display());
    }
}

fn load_docs(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted {
        #[serde(default)]
        docs: Vec<ProjectDoc>,
        #[serde(default)]
        doc_counter: usize,
        #[serde(default)]
        comments: Vec<DocComment>,
        #[serde(default)]
        comment_counter: usize,
    }
    let Ok(raw) = std::fs::read_to_string(docs_file()) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: {} is unreadable — starting with an empty document space", docs_file().display());
        return;
    };
    let max_id = parsed.docs.iter()
        .filter_map(|d| d.id.strip_prefix("d-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.doc_counter = store.doc_counter.max(parsed.doc_counter).max(max_id);
    let max_cid = parsed.comments.iter()
        .filter_map(|c| c.id.strip_prefix("dc-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.comment_counter = store.comment_counter.max(parsed.comment_counter).max(max_cid);
    println!("restored {} document(s) and {} comment(s) from {}", parsed.docs.len(), parsed.comments.len(), docs_file().display());
    store.docs = parsed.docs;
    store.doc_comments = parsed.comments;
}

// ---------------------------------------------------------------------------
// Paused-container registry persistence — /data/paused.json, same atomic
// tmp+rename write as the runs file. There is no container metadata to record "paused",
// so this file is what keeps platform-paused containers distinguishable
// from user-stopped ones across orchestrator restarts.
// ---------------------------------------------------------------------------

fn paused_file() -> std::path::PathBuf {
    data_dir().join("paused.json")
}

fn save_paused(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> {
        paused: &'a HashMap<String, PausedInfo>,
    }
    let payload = match serde_json::to_string_pretty(&Persisted { paused: &store.paused }) {
        Ok(p) => p,
        Err(_) => return,
    };
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = paused_file();
    let tmp = dir.join("paused.json.tmp");
    if std::fs::write(&tmp, payload).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        eprintln!("warning: could not persist paused registry to {}", path.display());
    }
}

/// Restore the paused registry at boot. Entries whose container vanished
/// (removed while the orchestrator was down) are dropped lazily — the
/// sweeper and delete path tolerate stale names.
fn load_paused(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted {
        #[serde(default)]
        paused: HashMap<String, PausedInfo>,
    }
    let Ok(raw) = std::fs::read_to_string(paused_file()) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: {} is unreadable — starting with an empty paused registry", paused_file().display());
        return;
    };
    if !parsed.paused.is_empty() {
        println!("restored {} paused container(s) from {}", parsed.paused.len(), paused_file().display());
    }
    store.paused = parsed.paused;
}

// ---------------------------------------------------------------------------
// Agent registry persistence — /data/agents.json, same atomic tmp+rename
// write as the other registries. tmux sessions are ephemeral; this file is
// what keeps stopped agents visible (with a Start button) across restarts.
// ---------------------------------------------------------------------------

fn agents_file() -> std::path::PathBuf {
    data_dir().join("agents.json")
}

fn save_agents(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> {
        agents: &'a BTreeSet<String>,
    }
    let payload = match serde_json::to_string_pretty(&Persisted { agents: &store.agents }) {
        Ok(p) => p,
        Err(_) => return,
    };
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = agents_file();
    let tmp = dir.join("agents.json.tmp");
    if std::fs::write(&tmp, payload).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        eprintln!("warning: could not persist agent registry to {}", path.display());
    }
}

fn load_agents(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted {
        #[serde(default)]
        agents: BTreeSet<String>,
    }
    let Ok(raw) = std::fs::read_to_string(agents_file()) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: {} is unreadable — starting with an empty agent registry", agents_file().display());
        return;
    };
    if !parsed.agents.is_empty() {
        println!("restored {} agent(s) from {}", parsed.agents.len(), agents_file().display());
    }
    store.agents = parsed.agents;
}

/// Generic atomic JSON write for the smaller registries (tmp + rename).
/// All stores are private: they carry agent output, prompts and config, so
/// they are created 0600 in a 0700 directory regardless of `_private`.
fn write_json_atomic<T: Serialize>(name: &str, value: &T, _private: bool) -> bool {
    let payload = match serde_json::to_string_pretty(value) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let path = data_dir().join(name);
    let ok = write_atomic_private(&path, &payload).is_ok();
    if !ok {
        eprintln!("warning: could not persist {}", path.display());
    }
    ok
}

// ---------------------------------------------------------------------------
// Personas / skills / tasks / config / routines persistence. These used to be
// in-memory only; the org features (budgets, org chart, skill bench) make them
// durable. Same tmp+rename contract as runs.json.
// ---------------------------------------------------------------------------

fn save_personas(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> { personas: &'a [Persona] }
    write_json_atomic("personas.json", &Persisted { personas: &store.personas }, false);
}

fn load_personas(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted { #[serde(default)] personas: Vec<Persona> }
    let Ok(raw) = std::fs::read_to_string(data_dir().join("personas.json")) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: personas.json is unreadable — keeping seeded personas");
        return;
    };
    if parsed.personas.is_empty() { return; }
    println!("restored {} persona(s)", parsed.personas.len());
    store.personas = parsed.personas;
}

fn save_config(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> { config: &'a AiConfig }
    write_json_atomic("config.json", &Persisted { config: &store.config }, true);
}

fn load_config(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted { #[serde(default)] config: Option<AiConfig> }
    let Ok(raw) = std::fs::read_to_string(data_dir().join("config.json")) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: config.json is unreadable — keeping defaults");
        return;
    };
    if let Some(cfg) = parsed.config {
        println!("restored provider config from config.json");
        store.config = cfg;
    }
}

fn save_skills(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> { skills: &'a [Skill] }
    write_json_atomic("skills.json", &Persisted { skills: &store.skills }, false);
}

fn load_skills(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted { #[serde(default)] skills: Vec<Skill> }
    let Ok(raw) = std::fs::read_to_string(data_dir().join("skills.json")) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: skills.json is unreadable — keeping seeded skills");
        return;
    };
    println!("restored {} skill(s)", parsed.skills.len());
    store.skills = parsed.skills;
}

fn save_tasks(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> { tasks: &'a [Task], task_counter: usize }
    write_json_atomic("tasks.json", &Persisted { tasks: &store.tasks, task_counter: store.task_counter }, false);
}

fn load_tasks(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted { #[serde(default)] tasks: Vec<Task>, #[serde(default)] task_counter: usize }
    let Ok(raw) = std::fs::read_to_string(data_dir().join("tasks.json")) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: tasks.json is unreadable — starting with an empty board");
        return;
    };
    let max_id = parsed.tasks.iter()
        .filter_map(|t| t.id.strip_prefix("t-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.task_counter = store.task_counter.max(parsed.task_counter).max(max_id);
    println!("restored {} task(s)", parsed.tasks.len());
    store.tasks = parsed.tasks;
}

fn save_routines(store: &Store) {
    #[derive(Serialize)]
    struct Persisted<'a> { routines: &'a [Routine], routine_counter: usize }
    write_json_atomic("routines.json", &Persisted { routines: &store.routines, routine_counter: store.routine_counter }, false);
}

fn load_routines(store: &mut Store) {
    #[derive(Deserialize)]
    struct Persisted { #[serde(default)] routines: Vec<Routine>, #[serde(default)] routine_counter: usize }
    let Ok(raw) = std::fs::read_to_string(data_dir().join("routines.json")) else { return };
    let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
        eprintln!("warning: routines.json is unreadable — starting with no routines");
        return;
    };
    let max_id = parsed.routines.iter()
        .filter_map(|r| r.id.strip_prefix("rt-").and_then(|n| n.parse::<usize>().ok()))
        .max().unwrap_or(0);
    store.routine_counter = store.routine_counter.max(parsed.routine_counter).max(max_id);
    println!("restored {} routine(s)", parsed.routines.len());
    store.routines = parsed.routines;
}

// ---------------------------------------------------------------------------
// Cron — 5-field local-time schedules for routines
// ---------------------------------------------------------------------------

struct CronSpec {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    doms: Vec<u32>,
    months: Vec<u32>,
    dows: Vec<u32>,
}

/// One field: `*`, `n`, `a-b`, lists `1,15`, steps `*/5` / `1-30/2`.
fn parse_cron_field(spec: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut out = Vec::new();
    for part in spec.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (r, s.parse::<u32>().ok()?),
            None => (part, 1),
        };
        if step == 0 { return None; }
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)
        } else {
            let v = range.parse::<u32>().ok()?;
            (v, v)
        };
        if lo < min || hi > max || lo > hi { return None; }
        let mut v = lo;
        while v <= hi { out.push(v); v += step; }
    }
    out.sort_unstable();
    out.dedup();
    Some(out)
}

fn cron_parse(expr: &str) -> Option<CronSpec> {
    let f: Vec<&str> = expr.split_whitespace().collect();
    if f.len() != 5 { return None; }
    let mut dows = parse_cron_field(f[4], 0, 7)?;
    dows = dows.into_iter().map(|d| if d == 7 { 0 } else { d }).collect();
    dows.sort_unstable();
    dows.dedup();
    Some(CronSpec {
        minutes: parse_cron_field(f[0], 0, 59)?,
        hours: parse_cron_field(f[1], 0, 23)?,
        doms: parse_cron_field(f[2], 1, 31)?,
        months: parse_cron_field(f[3], 1, 12)?,
        dows,
    })
}

fn cron_matches_day(spec: &CronSpec, t: &chrono::DateTime<Local>) -> bool {
    let dom_any = spec.doms.len() == 31;
    let dow_any = spec.dows.len() == 7;
    let dom_ok = spec.doms.contains(&t.day());
    let dow_ok = spec.dows.contains(&t.weekday().num_days_from_sunday());
    if dom_any && dow_any { true }
    else if dom_any { dow_ok }
    else if dow_any { dom_ok }
    else { dom_ok || dow_ok } // classic cron: both restricted → OR
}

/// First occurrence strictly after `after_secs` (local time). Scans at most
/// two years ahead so a nonsense-but-valid cron cannot loop forever.
fn next_run_at(expr: &str, after_secs: u64) -> Option<u64> {
    let spec = cron_parse(expr)?;
    // DST fall-back makes one local minute ambiguous; .single() would return
    // None and freeze that routine forever. Take the earliest occurrence.
    let mut t = match Local.timestamp_opt(after_secs as i64, 0) {
        chrono::LocalResult::Single(t) => t,
        chrono::LocalResult::Ambiguous(a, _) => a,
        chrono::LocalResult::None => return None,
    }.with_second(0)?.with_nanosecond(0)?;
    t += chrono::Duration::minutes(1);
    for _ in 0..(366 * 2 * 24 * 60u32) {
        if spec.months.contains(&t.month())
            && spec.hours.contains(&t.hour())
            && spec.minutes.contains(&t.minute())
            && cron_matches_day(&spec, &t)
        {
            return Some(t.timestamp() as u64);
        }
        t += chrono::Duration::minutes(1);
    }
    None
}

/// Fire one routine now: skip when its project already has a live run, else
/// spawn the run and record the outcome on the routine.
fn fire_routine(app: &App, routine: &Routine) -> Result<Run, ApiError> {
    let busy = {
        let store = app.store.lock().unwrap();
        store.runs.iter().any(|r| r.project_id == routine.project_id
            && (r.status == "running" || r.status == "waiting_human"))
    };
    let now = now_secs();
    if busy {
        // Do NOT consume the occurrence: once the project frees up, the next
        // 30s tick fires the routine instead of silently skipping it (the
        // Paperclip "event wake" behaviour, adapted to cron).
        let mut store = app.store.lock().unwrap();
        if let Some(r) = store.routines.iter_mut().find(|r| r.id == routine.id) {
            r.last_result = format!("waiting: project busy (since {})", now);
        }
        save_routines(&store);
        return Err(err(StatusCode::CONFLICT, "project already has a running mission"));
    }
    let result = spawn_run_with(app, &routine.project_id, &routine.task, routine.loop_mode, 1, "scheduled", Some(&routine.id));
    let mut store = app.store.lock().unwrap();
    if let Some(r) = store.routines.iter_mut().find(|r| r.id == routine.id) {
        r.last_run_at = now;
        match &result {
            Ok(run) => {
                r.last_run_id = Some(run.id.clone());
                r.last_result = "started".into();
            }
            Err(e) => r.last_result = format!("error: {}", e.1),
        }
    }
    save_routines(&store);
    result
}

/// Background scheduler: ticks every 30 s, fires enabled routines whose next
/// occurrence has passed. Restart-safe — occurrences missed while the process
/// was down are recorded but not replayed.
async fn routine_scheduler(app: App) {
    let mut boot = true;
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        ticker.tick().await;
        let now = now_secs();
        let due = {
            let mut store = app.store.lock().unwrap();
            let routines = store.routines.clone();
            let mut due = Vec::new();
            let mut changed = false;
            for r in routines {
                if !r.enabled { continue; }
                let base = if r.last_run_at > 0 { r.last_run_at } else { r.created_at.max(1) };
                let Some(next) = next_run_at(&r.cron, base) else { continue };
                if next > now { continue; }
                if boot {
                    if let Some(x) = store.routines.iter_mut().find(|x| x.id == r.id) {
                        x.last_run_at = now;
                        x.last_result = "missed while orchestrator was down".into();
                    }
                    changed = true;
                } else {
                    due.push(r);
                }
            }
            if changed { save_routines(&store); }
            due
        };
        boot = false;
        for r in due {
            if let Err(e) = fire_routine(&app, &r) {
                eprintln!("routine {} did not start: {}", r.id, e.1);
            }
        }
    }
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

/// Write a text deliverable into the shared workspace. Host execution means
/// the workspace is a local path — write it directly instead of piping model
/// output through a heredoc, so an emitted `AAP_EOF_…` line can never run
/// shell commands on the user's machine.
async fn write_deliverable(_app: &App, _agent: &str, run_id: &str, role: &str, output: &str) -> Result<String, ApiError> {
    let clean = output.replace('\r', "");
    let ws = hostexec::workspace_str();
    let path = std::path::PathBuf::from(format!("{ws}/{run_id}-{role}.md"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(
            StatusCode::INTERNAL_SERVER_ERROR, format!("could not create {}: {e}", parent.display())))?;
    }
    std::fs::write(&path, clean).map_err(|e| err(
        StatusCode::INTERNAL_SERVER_ERROR, format!("writing {} failed: {e}", path.display())))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Write FILES-block entries into the repo working tree (a local path under
/// host execution). Written directly — never through a shell heredoc — and
/// traversal is rejected here even though parse_files already guards it.
async fn apply_files_to_repo(_app: &App, _agent: &str, repo_path: &str, files: &[(String, String)]) -> Result<usize, String> {
    let root = std::path::Path::new(repo_path);
    let mut applied = 0usize;
    for (path, content) in files {
        if path.starts_with('/') || path.split('/').any(|c| c == ".." || c == ".") {
            return Err(format!("refusing unsafe file path '{path}'"));
        }
        let full = root.join(path);
        if let Some(dir) = full.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        std::fs::write(&full, content.replace('\r', ""))
            .map_err(|e| format!("writing {path} failed: {e}"))?;
        applied += 1;
    }
    Ok(applied)
}

/// Design/code delivery shared by the relay and meeting-revision paths: when a
/// dev/UX agent's reply carries a FILES block (and the project has a repo),
/// write those files into the repo working tree in the agent's container and
/// append an honest note to the stored deliverable (applied / failed / no
/// container). The FILES section itself stays in the stored output so the UI
/// shows the actual code.
async fn apply_files_note(app: &App, repo_path: Option<&str>, role: &str, output: &mut String) {
    let Some(rp) = repo_path else { return };
    if !(role.starts_with("dev") || role.starts_with("ux")) { return; }
    let files = parse_files(output);
    if files.is_empty() { return; }
    match app.agent_container(role).await {
        Some((cid, _)) => match apply_files_to_repo(app, &cid, rp, &files).await {
            Ok(n) => output.push_str(&format!(
                "\n\n*(applied {n} file(s) to the repo working tree — they ride the mission PR: {})*",
                files.iter().map(|(p, _)| format!("`{p}`")).collect::<Vec<_>>().join(", "),
            )),
            Err(e) => output.push_str(&format!("\n\n*(FAILED to apply files to the repo: {e})*")),
        },
        None => output.push_str("\n\n*(files NOT applied — no running container for this role)*"),
    }
}

/// Meeting loop bound — after this many meeting rounds, still-open questions are
/// escalated to the human (need-human) and then closed; the PO decides in the summary.
const MAX_MEETING_ROUNDS: u32 = 2;

/// Loop mode bound — a loop chain spawns at most this many iterations.
const MAX_LOOP_ITERATIONS: u32 = 8;

/// How long a need-human wait holds the run before the team proceeds with a note.
const HUMAN_TIMEOUT_SECS: u64 = 3600;

/// Cap for the PR stage's in-mission GitHub device-flow wait (GitHub codes
/// live ~900s; the wait ends with the earlier of the code's expiry and this).
const DEVICE_AUTH_WAIT_CAP_SECS: u64 = 900;

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

/// Design+code delivery: dev/UX agents may end their reply with a section
/// exactly titled `## FILES` — every entry is `### <repo-relative-path>`
/// followed by ONE fenced block holding the COMPLETE file content (full file,
/// never a diff). The orchestrator writes these into the repo working tree in
/// the agent's container and the PR stage commits whatever changed — this is
/// how missions ship real code and design artifacts instead of prose about
/// them. Line index where that section starts (None = absent).
fn find_files(output: &str) -> Option<usize> {
    output.lines().position(|l| l.trim().eq_ignore_ascii_case("## FILES"))
}

/// (path, full content) pairs from the FILES section. Guarded on purpose:
/// paths are interpolated into a quoted sh script, so they must be relative
/// with a conservative charset and no `..`; counts/sizes are bounded; content
/// may not contain the heredoc terminator.
fn parse_files(output: &str) -> Vec<(String, String)> {
    let Some(start) = find_files(output) else { return Vec::new() };
    let mut files: Vec<(String, String)> = Vec::new();
    let mut path: Option<String> = None;
    let mut in_fence = false;
    let mut body = String::new();
    for line in output.lines().skip(start + 1) {
        let t = line.trim_end();
        if in_fence {
            if t.trim_start().starts_with("```") {
                if let Some(p) = path.take() {
                    if !body.contains("AAP_EOF_9Z") {
                        files.push((p, std::mem::take(&mut body)));
                    }
                }
                in_fence = false;
            } else {
                body.push_str(line);
                body.push('\n');
            }
        } else if let Some(rest) = t.strip_prefix("### ") {
            path = Some(rest.trim().to_string()); // replaces an entry that never got a block
        } else if t.trim_start().starts_with("```") {
            if path.is_some() { in_fence = true; }
        }
    }
    files.retain(|(p, c)| {
        !p.is_empty() && p.len() <= 200
            && !p.starts_with('/') && !p.split('/').any(|seg| seg == "..")
            && p.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'))
            && !c.is_empty() && c.len() <= 65_536
    });
    files.truncate(12);
    files
}

/// Deliverable text without the FILES section — full-file listings would drown
/// the handoff summary later teammates read.
fn strip_files(output: &str) -> String {
    match find_files(output) {
        Some(start) => output.lines().take(start).collect::<Vec<_>>().join("\n").trim_end().to_string(),
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
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        if run.status != "running" && run.status != "waiting_human" { return; }
        if let Some(step) = run.steps.iter_mut().find(|s| s.role == role && s.kind == "work") {
            step.status = "done".into();
            step.output = output.to_string();
            step.container = container;
            step.deliverable = deliverable;
            step.finished_at = now_secs();
            if rev.is_some() { step.rev = rev; }
        }
    }
    save_runs(&store);
}

/// True once POST /runs/{id}/stop flagged this run.
fn stop_requested(app: &App, run_id: &str) -> bool {
    app.store.lock().unwrap().runs.iter().find(|r| r.id == run_id).map(|r| r.stop_requested).unwrap_or(false)
}

/// Terminal runs (done / stopped / error) must never be moved back to life by
/// a late tail write — only the explicit per-step retry endpoint reopens one.
fn run_is_live(app: &App, run_id: &str) -> bool {
    app.store.lock().unwrap().runs.iter().find(|r| r.id == run_id)
        .map(|r| r.status == "running" || r.status == "waiting_human")
        .unwrap_or(false)
}

/// USD per million tokens for a model: the editable table first, then the
/// configured default. `false` = no price known, so the step's cost is not a
/// real estimate (UI marks it).
fn model_price(app: &App, model: &str) -> (f64, f64, bool) {
    let cfg = app.store.lock().unwrap().config.clone();
    if let Some(p) = cfg.pricing.get(model) {
        return (p.input_per_mtok, p.output_per_mtok, true);
    }
    if cfg.default_input_per_mtok > 0.0 || cfg.default_output_per_mtok > 0.0 {
        return (cfg.default_input_per_mtok, cfg.default_output_per_mtok, false);
    }
    (0.0, 0.0, false)
}

fn usage_cost(usage: LlmUsage, input_per_mtok: f64, output_per_mtok: f64) -> f64 {
    usage.input_tokens as f64 * input_per_mtok / 1_000_000.0
        + usage.output_tokens as f64 * output_per_mtok / 1_000_000.0
}

/// Add one provider call's usage to the run ledger (and to the step when it
/// belongs to one) and persist. Raises the soft alert once, without stopping.
fn record_usage(app: &App, run_id: &str, role: &str, kind: &str, model: &str, usage: LlmUsage) {
    let (ip, op, priced) = model_price(app, model);
    let cost = usage_cost(usage, ip, op);
    let mut store = app.store.lock().unwrap();
    let alert_pct = store.runs.iter().find(|r| r.id == run_id)
        .and_then(|r| store.projects.iter().find(|p| p.id == r.project_id))
        .map(|p| p.budget_alert_pct.clamp(1, 100) as f64 / 100.0)
        .unwrap_or(0.8);
    let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) else { return };
    run.input_tokens += usage.input_tokens;
    run.output_tokens += usage.output_tokens;
    run.cost_usd += cost;
    if !kind.is_empty() {
        if let Some(step) = run.steps.iter_mut().find(|s| s.role == role && s.kind == kind) {
            step.input_tokens += usage.input_tokens;
            step.output_tokens += usage.output_tokens;
            step.cost_usd += cost;
            if !priced { step.priced = false; }
        }
    }
    if !run.cost_alerted {
        if let Some(budget) = run.budget_usd.filter(|b| *b > 0.0) {
            if run.cost_usd >= budget * alert_pct {
                run.cost_alerted = true;
            }
        }
    }
    save_runs(&store);
}

/// Open the budget pause discussion (once per run) and return its id.
fn raise_budget_discussion(app: &App, run_id: &str, cost: f64, budget: f64) -> String {
    let mut store = app.store.lock().unwrap();
    let disc_id = format!("d-{:03}", store.runs.iter().find(|r| r.id == run_id).map(|r| r.discussions.len() + 1).unwrap_or(1));
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        run.status = "waiting_human".into();
        run.phase = "budget".into();
        run.discussions.push(Discussion {
            id: disc_id.clone(),
            kind: "budget".into(),
            from: "orchestrator".into(),
            to: vec!["human".into()],
            topic: format!("งบประมาณของ mission นี้ถูกใช้ครบแล้ว — ใช้ไป ${cost:.4} จาก ${budget:.2}. เพิ่มงบเพื่อให้ทีมทำงานต่อ หรือกด Stop เพื่อหยุด mission"),
            status: "need_human".into(),
            answering: Some("human".into()),
            messages: vec![MeetingMessage {
                from: "orchestrator".into(),
                text: format!("💸 spend ${cost:.4} reached the ${budget:.2} budget — waiting for you to raise it (reply in chat alone does NOT raise it; use the Raise budget action)."),
                at: now_secs(),
            }],
            round: 0,
            created_at: now_secs(),
        });
    }
    save_runs(&store);
    disc_id
}

/// Cost guardrail checked before every provider/harness call in a run.
/// `true` = keep going, `false` = the run must wind down (user stopped it or
/// the budget pause timed out).
async fn guard_budget(app: &App, run_id: &str) -> bool {
    loop {
        let (cost, budget, existing) = {
            let store = app.store.lock().unwrap();
            match store.runs.iter().find(|r| r.id == run_id) {
                Some(run) => (
                    run.cost_usd,
                    run.budget_usd,
                    run.discussions.iter().rev()
                        .find(|d| d.kind == "budget" && d.status != "resolved")
                        .map(|d| d.id.clone()),
                ),
                None => return false,
            }
        };
        let budget = match budget.filter(|b| *b > 0.0) {
            Some(b) => b,
            None => return true,
        };
        if cost < budget { return true; }
        let disc_id = existing.unwrap_or_else(|| raise_budget_discussion(app, run_id, cost, budget));
        escalate_to_human(app, run_id, &disc_id, "increase the run budget to continue spending");
        match wait_for_human(app, run_id, &disc_id).await {
            HumanOutcome::Answered => {
                // A chat reply alone does not raise the budget — only
                // POST /runs/{id}/budget does. Re-check and re-pause if needed.
                let (cost_now, budget_now) = {
                    let store = app.store.lock().unwrap();
                    store.runs.iter().find(|r| r.id == run_id)
                        .map(|r| (r.cost_usd, r.budget_usd))
                        .unwrap_or((cost, Some(budget)))
                };
                if budget_now.unwrap_or(0.0) > cost_now {
                    let mut store = app.store.lock().unwrap();
                    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                        if let Some(d) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                            d.status = "resolved".into();
                            d.answering = None;
                        }
                    }
                    save_runs(&store);
                    return true;
                }
            }
            HumanOutcome::Stopped | HumanOutcome::TimedOut => {
                // Unlike a normal meeting, continuing past this point keeps
                // spending money — stop the run instead.
                finish_run(app, run_id, "stopped");
                return false;
            }
        }
    }
}

/// Fail closed when a project budget is set but the model has no price: an
/// unpriceable call would add $0 to the ledger and silently defeat the whole
/// guardrail. The run pauses (waiting_human) and resumes only once AI Config
/// has a price for the model (then a chat reply re-checks), or the user stops.
async fn guard_model_pricing(app: &App, run_id: &str, model: &str) -> bool {
    let has_budget = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .and_then(|r| r.budget_usd)
            .map(|b| b > 0.0)
            .unwrap_or(false)
    };
    if !has_budget { return true; }
    loop {
        let (ip, op, _) = model_price(app, model);
        if ip > 0.0 || op > 0.0 { return true; }
        let disc_id = {
            let mut store = app.store.lock().unwrap();
            let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) else { return false };
            if run.status != "running" && run.status != "waiting_human" { return false; }
            if let Some(d) = run.discussions.iter().rev().find(|d| d.kind == "unpriced" && d.status != "resolved") {
                d.id.clone()
            } else {
                let id = format!("d-{:03}", run.discussions.len() + 1);
                run.status = "waiting_human".into();
                run.phase = "budget".into();
                run.discussions.push(Discussion {
                    id: id.clone(),
                    kind: "unpriced".into(),
                    from: "orchestrator".into(),
                    to: vec!["human".into()],
                    topic: format!("โมเดล {model} ยังไม่มีราคา — งบประมาณคุมไม่ได้"),
                    status: "need_human".into(),
                    answering: Some("human".into()),
                    messages: vec![MeetingMessage {
                        from: "orchestrator".into(),
                        text: format!(
                            "⚖️ This project has a budget, but model '{model}' has no price in AI Config — cost would record as $0 and the guardrail would never trip. Add input/output USD per 1M tokens for this model (or set the default price), then reply here to continue. Chat alone cannot bypass this check; Stop ends the run."
                        ),
                        at: now_secs(),
                    }],
                    round: 0,
                    created_at: now_secs(),
                });
                id
            }
        };
        save_runs(&app.store.lock().unwrap());
        match wait_for_human(app, run_id, &disc_id).await {
            HumanOutcome::Answered => {
                let (ip, op, _) = model_price(app, model);
                if ip > 0.0 || op > 0.0 {
                    let mut store = app.store.lock().unwrap();
                    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                        if let Some(d) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                            d.status = "resolved".into();
                            d.answering = None;
                        }
                    }
                    save_runs(&store);
                    return true;
                }
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    run.status = "waiting_human".into();
                    run.phase = "budget".into();
                    if let Some(d) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                        d.status = "need_human".into();
                        d.answering = Some("human".into());
                        d.messages.push(MeetingMessage {
                            from: "orchestrator".into(),
                            text: format!("Still no price for '{model}' — add it in AI Config → Pricing, then reply again."),
                            at: now_secs(),
                        });
                    }
                }
                save_runs(&store);
            }
            HumanOutcome::Stopped | HumanOutcome::TimedOut => {
                finish_run(app, run_id, "stopped");
                return false;
            }
        }
    }
}

/// One LLM call inside a run: budget guard, retry, usage ledger. `kind` "" =
/// call not attached to a step (meeting answers, PR text, PO summary).
/// `Ok(None)` = the guard stopped the run — the caller must wind down.
async fn llm_step(app: &App, run_id: &str, role: &str, kind: &str, model: &str, system: &str, user: &str, max: u32) -> Result<Option<String>, ApiError> {
    if stop_requested(app, run_id) || !run_is_live(app, run_id) {
        return Ok(None);
    }
    if !guard_budget(app, run_id).await {
        return Ok(None);
    }
    if !guard_model_pricing(app, run_id, model).await {
        return Ok(None);
    }
    let (text, usage) = llm_retry_usage(app, model, system, user, max).await?;
    record_usage(app, run_id, role, kind, model, usage);
    Ok(Some(text))
}

// ---------------------------------------------------------------------------
// BYO CLI harnesses — a persona may "think" through an installed CLI agent
// ---------------------------------------------------------------------------

/// External harness calls are allowed this long before they are killed.
const HARNESS_TIMEOUT_SECS: u64 = 30 * 60;

fn persona_harness(app: &App, role: &str) -> (String, String) {
    let store = app.store.lock().unwrap();
    store.personas.iter().find(|p| p.role == role)
        .map(|p| (p.harness.clone(), p.harness_command.clone()))
        .unwrap_or_else(|| ("native".into(), String::new()))
}

/// Command template for a persona: its own override wins; otherwise the
/// preset for `claude` / `codex`; native has none.
fn harness_template(harness: &str, custom: &str) -> Option<String> {
    if !custom.trim().is_empty() { return Some(custom.trim().to_string()); }
    match harness {
        "claude" => Some("claude -p \"$(cat {prompt_file})\"".into()),
        "codex" => Some("codex exec \"$(cat {prompt_file})\"".into()),
        _ => None,
    }
}

fn harness_binary(template: &str) -> String {
    template.split_whitespace().next().unwrap_or("")
        .trim_matches(|c| c == '"' || c == '\'').to_string()
}

fn valid_binary_name(bin: &str) -> bool {
    !bin.is_empty() && bin.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

fn binary_installed(bin: &str) -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {} >/dev/null 2>&1", bin))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn list_harnesses(State(app): State<App>, headers: axum::http::HeaderMap) -> ApiResult {
    app.require_auth(&headers)?;
    let claude_cmd = harness_template("claude", "").unwrap_or_default();
    let codex_cmd = harness_template("codex", "").unwrap_or_default();
    let claude_bin = harness_binary(&claude_cmd);
    let codex_bin = harness_binary(&codex_cmd);
    Ok(json_ok(json!([
        { "id": "native", "label": "Built-in provider loop", "command": "", "binary": "", "installed": true },
        { "id": "claude", "label": "Claude Code CLI", "command": claude_cmd, "binary": claude_bin, "installed": binary_installed(&claude_bin) },
        { "id": "codex", "label": "Codex CLI", "command": codex_cmd, "binary": codex_bin, "installed": binary_installed(&codex_bin) },
        { "id": "custom", "label": "Custom command", "command": "", "binary": "", "installed": true },
    ])))
}

fn mark_harness_step(app: &App, run_id: &str, role: &str, harness: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id)
        .and_then(|r| r.steps.iter_mut().find(|s| s.role == role && s.kind == "work"))
    {
        step.harness = Some(harness.into());
        step.metered = false;
        step.priced = false;
    }
    save_runs(&store);
}

/// Run one step through an external CLI harness. The prompt is written 0600 to
/// the data dir; the harness runs on the host through the agent's session with
/// a 30-minute cap. Output is unmetered (cost unknown), so it is recorded only
/// as the step's harness/metered flags — never as token spend.
async fn harness_step(
    app: &App, run_id: &str, role: &str, harness: &str, custom: &str,
    model: &str, system: &str, user: &str,
) -> Result<Option<String>, ApiError> {
    if stop_requested(app, run_id) || !run_is_live(app, run_id) { return Ok(None); }
    if !guard_budget(app, run_id).await { return Ok(None); }
    let template = harness_template(harness, custom).ok_or_else(|| err(
        StatusCode::BAD_REQUEST,
        format!("persona harness '{harness}' has no command — set a command template or switch it to native"),
    ))?;
    let binary = harness_binary(&template);
    if !valid_binary_name(&binary) {
        return Err(err(StatusCode::BAD_REQUEST, format!("invalid harness command '{template}'")));
    }
    let (cid, _) = app.agent_container(role).await.ok_or_else(|| err(
        StatusCode::CONFLICT,
        format!("no running session for {role} — start the agent first so its CLI harness can run"),
    ))?;
    let (code, _) = app.exec_in(&cid, &format!("command -v {binary} >/dev/null 2>&1")).await
        .unwrap_or((-1, String::new()));
    if code != 0 {
        return Err(err(StatusCode::FAILED_DEPENDENCY, format!(
            "harness '{harness}' is not installed on this machine (missing `{binary}`) — install it or switch this persona to native"
        )));
    }
    let tmp = data_dir().join("tmp");
    let _ = std::fs::create_dir_all(&tmp);
    let n = app.seq.fetch_add(1, Ordering::SeqCst);
    let prompt_file = tmp.join(format!("harness-{n}.md"));
    write_atomic_private(&prompt_file, &format!("{system}\n\n{user}\n")).map_err(|e| err(
        StatusCode::INTERNAL_SERVER_ERROR, format!("could not write harness prompt: {e}")))?;
    let cmd = template
        .replace("{prompt_file}", &hostexec::shq(&prompt_file.to_string_lossy()))
        .replace("{model}", &hostexec::shq(model))
        .replace("{role}", &hostexec::shq(role));
    let run = hostexec::run_with_timeout(
        &cid, &cmd, &[], Some(std::time::Duration::from_secs(HARNESS_TIMEOUT_SECS)),
    ).await;
    let _ = std::fs::remove_file(&prompt_file);
    match run {
        Ok((0, out)) => {
            let out = out.trim().to_string();
            if out.is_empty() {
                Err(err(StatusCode::BAD_GATEWAY, format!("harness '{harness}' returned an empty answer")))
            } else {
                Ok(Some(out))
            }
        }
        Ok((code, out)) => Err(err(StatusCode::BAD_GATEWAY, format!(
            "harness '{harness}' exited {code}: {}", one_line(&out, 400)))),
        Err(e) if e.contains("timed out") => Err(err(StatusCode::GATEWAY_TIMEOUT, format!(
            "harness '{harness}' timed out after {} min and was killed", HARNESS_TIMEOUT_SECS / 60))),
        Err(e) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, format!("harness failed: {e}"))),
    }
}

/// Close a run: mark remaining pending steps "skipped", set the final status/phase, persist.
fn finish_run(app: &App, run_id: &str, status: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        if run.status != "running" && run.status != "waiting_human" { return; }
        for step in run.steps.iter_mut().filter(|s| s.status == "pending") {
            step.status = "skipped".into();
        }
        // The step that was mid-flight when the run ended would otherwise show
        // "working" forever — nothing will ever move it forward again. Close it.
        for step in run.steps.iter_mut().filter(|s| s.status == "working") {
            step.status = "stopped".into();
            step.output = format!("stopped mid-work — the run closed as {status} while this step was in flight");
            if step.finished_at == 0 { step.finished_at = now_secs(); }
        }
        run.status = status.into();
        run.phase = "done".into();
        run.watchdog_note = None;
        run.watchdog_at = 0;
        for d in run.discussions.iter_mut().filter(|d| d.status != "resolved") {
            d.status = "resolved".into();
            d.answering = None;
        }
        save_runs(&store);
    }
}

/// Exit point for an `Ok(None)` from llm_step: the user pressed Stop (close the
/// run as stopped) or the budget guard paused it (leave waiting_human intact).
/// Returning without this left a stopped run looking alive forever.
fn wind_down_or_pause(app: &App, run_id: &str) {
    if stop_requested(app, run_id) {
        finish_run(app, run_id, "stopped");
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

/// Outcome of the PR stage's in-mission GitHub device-flow wait.
enum GhAuthOutcome {
    /// gh is logged in as this account (from the cache or a post-reply recheck)
    Connected(String),
    /// the user pressed Stop — finish_run() closes the run
    Stopped,
    /// flow expired / denied / disconnected / never started
    Ended,
    /// the human replied in chat but gh is still not authenticated
    RepliedUnauthed,
}

/// Open the PR stage's GitHub auth request: a need-human discussion carrying
/// the device-flow code + URL, with the run flipped to waiting_human so the
/// whole UI (badge, inbox, reply form) lights up. Returns the discussion id.
fn raise_github_auth_discussion(app: &App, run_id: &str, dev_role: &str, user_code: &str, verification_url: &str, expires_in: u64) -> String {
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        let disc_id = format!("d-{:03}", run.discussions.len() + 1);
        let mins = expires_in.max(60) / 60;
        run.status = "waiting_human".into();
        run.discussions.push(Discussion {
            id: disc_id.clone(),
            kind: String::new(),
            from: dev_role.into(),
            to: vec!["human".into()],
            topic: "GitHub connector — อนุมัติสิทธิ์ push เพื่อเปิด PR".into(),
            status: "need_human".into(),
            answering: Some("human".into()),
            messages: vec![MeetingMessage {
                from: "orchestrator".into(),
                text: format!("🐙 ขั้นตอน PR ต้องใช้สิทธิ์ GitHub — อนุมัติให้ container ของ Dev:\n1) เปิด {verification_url}\n2) ใส่รหัส {user_code} (หมดอายุใน ~{mins} นาที)\nเชื่อมต่อสำเร็จแล้วทีมจะ push และเปิด PR ต่อทันที หรือพิมพ์ตอบในแชทเพื่อให้ตรวจสอบอีกครั้ง/ข้ามขั้นนี้"),
                at: now_secs(),
            }],
            round: run.round,
            created_at: now_secs(),
        });
        save_runs(&store);
        disc_id
    } else {
        String::new()
    }
}

/// Wait for the in-mission device flow to land. The connector cache flipping
/// to connected is the success signal — inject_github_token writes it only
/// after a real in-container login, and `at >= baseline` (captured before the
/// flow started, which also clears the key) rules out any stale hit. The
/// pending flow disappearing without a connection means expired/denied/
/// disconnected. A chat reply from the human triggers ONE authoritative
/// `gh auth status` recheck (they may have pasted a token via the connector
/// page, or told the team to skip). 1s ticks, lock never held across an
/// await — same discipline as wait_for_human.
async fn wait_for_github_auth(app: &App, run_id: &str, disc_id: &str, container_id: &str, baseline: u64, deadline: u64) -> GhAuthOutcome {
    let cache_key = format!("{container_id}:github");
    let mut human_seen = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .and_then(|r| r.discussions.iter().find(|d| d.id == disc_id))
            .map(|d| d.messages.iter().filter(|m| m.from == "human").count())
            .unwrap_or(0)
    };
    loop {
        let mut human_replied = false;
        {
            let store = app.store.lock().unwrap();
            let run = match store.runs.iter().find(|r| r.id == run_id) {
                Some(r) => r,
                None => return GhAuthOutcome::Ended,
            };
            if run.stop_requested {
                // leave the status as-is — finish_run() closes the run properly
                return GhAuthOutcome::Stopped;
            }
            if let Some(c) = store.connector_cache.get(&cache_key) {
                if c.state == "connected" && c.at >= baseline {
                    return GhAuthOutcome::Connected(c.login.clone().unwrap_or_else(|| "github".into()));
                }
            }
            // success writes the cache BEFORE the poll task drops the flow, so
            // a missing flow with no fresh "connected" is a real end
            if !store.pending_device_flows.contains_key(container_id) {
                return GhAuthOutcome::Ended;
            }
            if let Some(disc) = run.discussions.iter().find(|d| d.id == disc_id) {
                human_replied = disc.messages.iter().filter(|m| m.from == "human").count() > human_seen;
            }
            if now_secs() >= deadline {
                return GhAuthOutcome::Ended;
            }
        }
        if human_replied {
            let (code, _) = app.exec_in(container_id, "command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1")
                .await
                .unwrap_or((1, String::new()));
            return if code == 0 { GhAuthOutcome::Connected("github".into()) } else { GhAuthOutcome::RepliedUnauthed };
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

/// The PR stage's GitHub auth rescue: mint a device code, surface it in the
/// mission chat as a need-human request, and wait for the user to approve in
/// the browser (or reply in chat / Stop / expiry). On a non-connected,
/// non-stopped outcome the pending flow is dropped so a late approval cannot
/// silently log the container in after the stage already moved on.
async fn try_in_mission_github_auth(app: &App, run_id: &str, dev_role: &str, container_id: &str) -> GhAuthOutcome {
    let baseline = now_secs();
    let (user_code, verification_url, expires_in) = match start_github_device_flow(app, container_id).await {
        Ok(x) => x,
        // GitHub unreachable — nothing to ask the human for; the caller's skip
        // note carries the reason
        Err(_) => return GhAuthOutcome::Ended,
    };
    let disc_id = raise_github_auth_discussion(app, run_id, dev_role, &user_code, &verification_url, expires_in);
    let deadline = baseline + expires_in.min(DEVICE_AUTH_WAIT_CAP_SECS);
    let outcome = wait_for_github_auth(app, run_id, &disc_id, container_id, baseline, deadline).await;

    {
        let mut store = app.store.lock().unwrap();
        // finish_run() resolves the discussion on Stop, and the flow may still
        // complete there for future runs — only Ended/RepliedUnauthed void it
        if !matches!(outcome, GhAuthOutcome::Connected(_) | GhAuthOutcome::Stopped) {
            store.pending_device_flows.remove(container_id);
        }
        if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
            if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                match &outcome {
                    GhAuthOutcome::Connected(login) => {
                        if run.status == "waiting_human" { run.status = "running".into(); }
                        disc.status = "resolved".into();
                        disc.answering = None;
                        disc.messages.push(MeetingMessage {
                            from: "orchestrator".into(),
                            text: format!("✅ GitHub connected as @{login} — pushing branch and opening the PR"),
                            at: now_secs(),
                        });
                    }
                    GhAuthOutcome::Stopped => {}
                    GhAuthOutcome::Ended | GhAuthOutcome::RepliedUnauthed => {
                        if run.status == "waiting_human" { run.status = "running".into(); }
                        disc.status = "resolved".into();
                        disc.answering = None;
                        let why = if matches!(outcome, GhAuthOutcome::RepliedUnauthed) {
                            "ยังไม่พบสิทธิ์ GitHub หลังคำตอบของคุณ"
                        } else {
                            "หมดเวลาอนุมัติ GitHub (โค้ดหมดอายุ)"
                        };
                        disc.messages.push(MeetingMessage {
                            from: "orchestrator".into(),
                            text: format!("{why} — ข้ามขั้น PR ไว้ (mission branch ยังอยู่ใน container เรียกใช้ได้เมื่อเชื่อมต่อแล้ว)"),
                            at: now_secs(),
                        });
                    }
                }
            }
        }
        save_runs(&store);
    }
    outcome
}

// ---------------------------------------------------------------------------
// Tail stages — after QA verifies: a REAL pull request, then the PO
// acceptance demo session
// ---------------------------------------------------------------------------

/// What the PR stage actually achieved. `status` mirrors the step status
/// (done | skipped | error); when done, `url` is the real github.com PR link.
struct PrOutcome { status: String, url: String, branch: String, note: String }

impl PrOutcome {
    /// One-line truth for prompts and the demo "delivery of record".
    fn describe(&self) -> String {
        if self.status == "done" {
            format!("Pull request OPEN: {} (branch `{}`)", self.url, self.branch)
        } else {
            format!("Pull request {}: {}", self.status, self.note)
        }
    }
}

/// Flip a tail step's status/output. Tail steps are found by role+kind — the
/// same persona can own work/pr/demo steps in one run.
async fn step_transition(app: &App, run_id: &str, role: &str, kind: &str, status: &str, output: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        if run.status != "running" && run.status != "waiting_human" { return; }
        if let Some(step) = run.steps.iter_mut().find(|s| s.role == role && s.kind == kind) {
            step.status = status.into();
            step.output = output.to_string();
            if status == "working" { step.started_at = now_secs(); }
            if status == "done" || status == "error" || status == "skipped" { step.finished_at = now_secs(); }
        }
    }
    save_runs(&store);
}

/// Append the two tail steps (pr / demo) as pending, in execution order.
async fn append_tail_steps(app: &App, run_id: &str, dev_role: &str, po_role: &str) {
    let personas = app.store.lock().unwrap().personas.clone();
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        let name_of = |role: &str| personas.iter().find(|p| p.role == role).map(|p| p.name.clone()).unwrap_or_else(|| role.to_string());
        let mk = |role: &str, kind: &str, title: &str| RunStep {
            role: role.into(), name: name_of(role), title: title.into(), kind: kind.into(),
            status: "pending".into(), output: String::new(),
            model: None, container: None, deliverable: None, rev: None,
            started_at: 0, finished_at: 0, harness: None,
            input_tokens: 0, output_tokens: 0, cost_usd: 0.0, metered: true, priced: true,
        };
        run.steps.push(mk(dev_role, "pr", "Open Pull Request"));
        run.steps.push(mk(po_role, "demo", "Acceptance Demo"));
        save_runs(&store);
    }
}

/// Single line, single-quoted-sh-safe, capped.
fn one_line(s: &str, max_chars: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).collect();
    flat.trim().chars().take(max_chars).collect()
}

/// First github.com .../pull/N URL in the text, else None. Used to capture the
/// REAL PR link out of `gh pr create` output — never fabricated.
fn extract_pr_url(text: &str) -> Option<String> {
    let idx = text.find("https://github.com/")?;
    let rest = &text[idx..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']);
    if url.contains("/pull/") { Some(url.to_string()) } else { None }
}

/// "VERDICT: PASS|FAIL" from the last matching line (case-insensitive,
/// backtick/asterisk tolerant, Thai ผ่าน/ไม่ผ่าน accepted). None = no verdict
/// line at all.
fn parse_verdict(text: &str) -> Option<String> {
    for line in text.lines().rev() {
        let clean = line.trim().trim_matches(['`', '*', ' ']);
        let lower = clean.to_lowercase();
        if let Some(rest) = lower.strip_prefix("verdict:") {
            let v = rest.trim();
            if v.starts_with("pass") { return Some("pass".into()); }
            if v.starts_with("fail") { return Some("fail".into()); }
            if v.starts_with("ผ่าน") { return Some("pass".into()); }
            if v.starts_with("ไม่ผ่าน") { return Some("fail".into()); }
        }
    }
    None
}

/// TITLE:/BODY: block out of the LLM's PR-text reply, with honest fallbacks.
fn parse_pr_text(reply: &str, task: &str, run_id: &str) -> (String, String) {
    let mut title = String::new();
    let mut body = String::new();
    let mut in_body = false;
    for line in reply.lines() {
        let lower = line.trim().to_lowercase();
        if !in_body && lower.starts_with("title:") {
            title = line.trim()[6..].trim().to_string();
        } else if lower.starts_with("body:") {
            body = line.trim()[5..].trim().to_string();
            in_body = true;
        } else if in_body {
            body.push('\n');
            body.push_str(line);
        }
    }
    let title = if title.is_empty() { format!("Mission {run_id}: {}", one_line(task, 60)) } else { one_line(&title, 100) };
    let body = if body.trim().is_empty() { task.to_string() } else { body.trim().to_string() };
    (title, body)
}

/// Real PR: mission branch in the dev's container, deliverables copied into
/// missions/<run_id>/, commit, push, `gh pr create`. Missing preconditions →
/// skipped with the honest reason; failed actions → error with the real output.
/// Max characters of `git diff` persisted for the review card.
const REVIEW_DIFF_MAX: usize = 16_000;
/// One human review, then (on reject) one Dev revision, then a second review.
const MAX_REVIEW_ROUNDS: u32 = 2;

enum ReviewOutcome {
    /// approved (or nothing to review) — the PR stage may run
    Proceed,
    /// not approved — skip the PR with this honest reason
    Skip(String),
    /// user pressed Stop during a review pause
    Stopped,
}

/// Stage the shared working tree and capture the exact diff the PR would push.
/// None = no session / no repo / no changes — the gate is skipped and the PR
/// stage reports the same honest reason.
async fn collect_repo_diff(app: &App, cid: &str, repo_path: &str) -> Option<(Vec<String>, String)> {
    let script = format!(
        "cd '{repo_path}' || exit 10; \
         git add -A >/dev/null 2>&1 || true; \
         git status --porcelain --untracked-files=all; \
         echo '---STAT---'; \
         git diff --cached --stat; \
         echo '---PATCH---'; \
         git diff --cached --no-color"
    );
    let (code, out) = app.exec_in(cid, &script).await.ok()?;
    if code != 0 { return None; }
    let (files_part, rest) = out.split_once("---STAT---").unwrap_or((out.as_str(), ""));
    let files: Vec<String> = files_part.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
    if files.is_empty() { return None; }
    let diff: String = rest.chars().take(REVIEW_DIFF_MAX).collect();
    Some((files, diff))
}

fn review_state(app: &App, run_id: &str) -> (String, String) {
    let store = app.store.lock().unwrap();
    store.runs.iter().find(|r| r.id == run_id)
        .and_then(|r| r.review.as_ref())
        .map(|r| (r.status.clone(), r.comment.clone()))
        .unwrap_or((String::new(), String::new()))
}

fn set_review_status(app: &App, run_id: &str, status: &str, comment: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        if let Some(review) = run.review.as_mut() {
            review.status = status.into();
            if !comment.is_empty() { review.comment = comment.into(); }
            review.decided_at = now_secs();
        }
    }
    save_runs(&store);
}

/// Persist the pending review and open the need-human discussion for it.
fn open_review(app: &App, run_id: &str, files: &[String], diff: &str) -> String {
    let mut store = app.store.lock().unwrap();
    let disc_id = format!("d-{:03}", store.runs.iter().find(|r| r.id == run_id).map(|r| r.discussions.len() + 1).unwrap_or(1));
    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
        // A budget stop / user stop may have closed the run while the diff was
        // being staged — never resurrect it as a live review.
        if run.status != "running" { return String::new(); }
        run.review = Some(RunReview {
            status: "pending".into(),
            diff: diff.to_string(),
            files: files.to_vec(),
            comment: String::new(),
            requested_at: now_secs(),
            decided_at: 0,
        });
        run.status = "waiting_human".into();
        run.phase = "review".into();
        let listing = files.iter().take(25).cloned().collect::<Vec<_>>().join("\n");
        run.discussions.push(Discussion {
            id: disc_id.clone(),
            kind: "review".into(),
            from: "orchestrator".into(),
            to: vec!["human".into()],
            topic: format!("ตรวจ diff ก่อน push/PR — {} ไฟล์ที่เปลี่ยน", files.len()),
            status: "need_human".into(),
            answering: Some("human".into()),
            messages: vec![MeetingMessage {
                from: "orchestrator".into(),
                text: format!("🔍 the team is ready to push. Review the diff in Mission Control, then Approve or Reject with a comment.\n\n```\n{listing}\n```"),
                at: now_secs(),
            }],
            round: 0,
            created_at: now_secs(),
        });
    }
    save_runs(&store);
    disc_id
}

/// Wait for the human's decision on the pending review. A plain chat message
/// ("why this file?") wakes the wait but is NOT a decision — the review stays
/// pending, the run stays visibly paused, and we keep waiting for an explicit
/// Approve/Reject or an APPROVE/REJECT chat line.
async fn wait_review(app: &App, run_id: &str, disc_id: &str) -> String {
    loop {
        match wait_for_human(app, run_id, disc_id).await {
            HumanOutcome::Answered => {
                let status = review_state(app, run_id).0;
                if status != "pending" { return status; }
                {
                    let mut store = app.store.lock().unwrap();
                    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                        if run.status == "running" { run.status = "waiting_human".into(); }
                        run.phase = "review".into();
                    }
                    save_runs(&store);
                }
            }
            HumanOutcome::TimedOut => {
                set_review_status(app, run_id, "timed_out", "");
                return "timed_out".into();
            }
            HumanOutcome::Stopped => return "stopped".into(),
        }
    }
}

/// Pre-push review gate. Approve → Proceed; first reject → Dev revises once
/// and a second review opens; second reject/timeout/Stop → Skip.
async fn review_gate(
    app: &App, run_id: &str, dev_role: &str, repo_url: &str, repo_path: &str,
    task: &str, project_name: &str,
) -> ReviewOutcome {
    let (cid, _) = match app.agent_container(dev_role).await {
        Some(x) => x,
        None => return ReviewOutcome::Proceed, // PR stage reports the missing session
    };
    if repo_url.trim().is_empty() { return ReviewOutcome::Proceed; }
    let (mut files, mut diff) = match collect_repo_diff(app, &cid, repo_path).await {
        Some(x) => x,
        None => return ReviewOutcome::Proceed,
    };
    step_transition(app, run_id, dev_role, "pr", "working", "waiting for diff review").await;
    let dev = persona_of(app, dev_role);

    for round in 0..MAX_REVIEW_ROUNDS {
        if !run_is_live(app, run_id) { return ReviewOutcome::Stopped; }
        let disc_id = open_review(app, run_id, &files, &diff);
        if disc_id.is_empty() { return ReviewOutcome::Stopped; }
        let status = wait_review(app, run_id, &disc_id).await;
        // The review discussion is closed either way; the outcome is in Run.review.
        {
            let mut store = app.store.lock().unwrap();
            if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                if let Some(d) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                    d.status = "resolved".into();
                    d.answering = None;
                }
            }
            save_runs(&store);
        }
        match status.as_str() {
            "approved" => return ReviewOutcome::Proceed,
            "stopped" => return ReviewOutcome::Stopped,
            "timed_out" => return ReviewOutcome::Skip("diff review timed out — nothing was pushed".into()),
            "rejected" if round + 1 >= MAX_REVIEW_ROUNDS => {
                return ReviewOutcome::Skip("rejected by the reviewer a second time — nothing was pushed".into());
            }
            "rejected" => {
                let comment = review_state(app, run_id).1;
                let goal_line = goal_ancestry_line(app, run_id, dev_role);
                let system = work_system(&dev.2, &dev.0, &dev.1, true, project_name,
                    &team_repo_line(&Some(repo_path.to_string())), "", &goal_line, run_id);
                let user = format!(
                    "## Mission\n{task}\n\n## Reviewer comment\n{}\n\n## Diff under review\n```\n{}\n```\n\nApply the requested changes to the repo now — re-emit the FULL FILES block for every file you change. Then summarise what changed.",
                    if comment.is_empty() { "(no comment)" } else { &comment }, diff
                );
                if let Some(m) = dev.3.as_deref() {
                    match llm_step(app, run_id, dev_role, "work", m, &system, &user, 6000).await {
                        Ok(Some(output)) => {
                            let mut clean = strip_ask(&output);
                            apply_files_note(app, Some(repo_path), dev_role, &mut clean).await;
                        }
                        // The budget guard stopped the run mid-revision.
                        Ok(None) => return ReviewOutcome::Stopped,
                        Err(_) => {}
                    }
                }
                if !run_is_live(app, run_id) { return ReviewOutcome::Stopped; }
                match collect_repo_diff(app, &cid, repo_path).await {
                    Some((f, d)) => { files = f; diff = d; }
                    None => return ReviewOutcome::Skip("the Dev revision produced no changes — nothing was pushed".into()),
                }
            }
            _ => return ReviewOutcome::Skip("diff review was not approved — nothing was pushed".into()),
        }
    }
    ReviewOutcome::Skip("diff review was not approved — nothing was pushed".into())
}

async fn run_pr_stage(
    app: &App, run_id: &str, dev_role: &str, repo_url: &str, task: &str, project_name: &str,
    dev: &(String, String, String, Option<String>),
) -> PrOutcome {
    let branch = run_id.to_string();
    let skip = |note: String| PrOutcome { status: "skipped".into(), url: String::new(), branch: branch.clone(), note };
    step_transition(app, run_id, dev_role, "pr", "working", "").await;

    let (cid, _cname) = match app.agent_container(dev_role).await {
        Some(x) => x,
        None => {
            let n = format!("no running container for {dev_role} — start the agent first (branch/PR not attempted)");
            step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
            return skip(n);
        }
    };
    if repo_url.trim().is_empty() {
        let n = "project has no git repo configured — set the repo URL on the Projects page".to_string();
        step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
        return skip(n);
    }
    let repo_path = match app.ensure_repo(&cid, repo_url).await {
        Ok(p) => p,
        Err(e) => {
            let n = format!("repo not available in the team workspace: {}", e.1);
            step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
            return skip(n);
        }
    };
    // gh auth + git identity for THIS container (idempotent, best-effort)
    app.ensure_tools(&cid).await;

    // Stage exactly what the PR would push BEFORE asking for review — branch,
    // missions/ deliverables and the code/design files the dev/UX agents
    // applied. The reviewed diff is therefore the pushed diff, and the gate
    // lives here (inside the PR stage) so a retry cannot bypass it.
    let ws = hostexec::workspace_str();
    let prep = format!(
        "cd '{repo_path}' || exit 10; \
         git remote get-url origin >/dev/null 2>&1 || {{ echo NO_REMOTE; exit 0; }}; \
         git fetch --all --quiet >/dev/null 2>&1 || true; \
         git checkout -q -B '{branch}' \"$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)\"; \
         mkdir -p 'missions/{run_id}'; \
         cp '{ws}/{run_id}-*.md' 'missions/{run_id}/' 2>/dev/null || true; \
         git add -A"
    );
    let (pcode, pout) = app.exec_in(&cid, &prep).await
        .unwrap_or((-1, "exec failed".into()));
    if pcode == 10 {
        let n = format!("repo path {repo_path} disappeared on this machine");
        step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
        return skip(n);
    }
    if pout.contains("NO_REMOTE") {
        let n = "no git remote 'origin' in the cloned repo — cannot push a PR".to_string();
        step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
        return skip(n);
    }
    match review_gate(app, run_id, dev_role, repo_url, &repo_path, task, project_name).await {
        ReviewOutcome::Proceed => {}
        ReviewOutcome::Stopped => {
            finish_run(app, run_id, "stopped");
            return PrOutcome { status: "skipped".into(), url: String::new(), branch: branch.clone(), note: "run stopped during diff review".into() };
        }
        ReviewOutcome::Skip(n) => {
            step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
            return skip(n);
        }
    }

    // Branch + commit: everything staged above rides the mission branch.
    let commit_msg = format!("mission {run_id}: team deliverables");
    let script = format!(
        "cd '{repo_path}' || exit 10; \
         git remote get-url origin >/dev/null 2>&1 || {{ echo NO_REMOTE; exit 0; }}; \
         git fetch --all --quiet >/dev/null 2>&1 || true; \
         git checkout -q -B '{branch}' \"$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)\"; \
         mkdir -p 'missions/{run_id}'; \
         cp '{ws}/{run_id}-*.md' 'missions/{run_id}/' 2>/dev/null || true; \
         git add -A; \
         git status --porcelain | head -30; \
         git commit -q -m '{commit_msg}' 2>/dev/null || echo NOTHING_TO_COMMIT; \
         git log -1 --format=%h 2>/dev/null"
    );
    let (code, out) = app.exec_in(&cid, &script).await
        .unwrap_or((-1, "exec failed".into()));
    if code == 10 {
        let n = format!("repo path {repo_path} disappeared on this machine");
        step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
        return skip(n);
    }
    if out.contains("NO_REMOTE") {
        let n = "no git remote 'origin' in the cloned repo — cannot push a PR".to_string();
        step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
        return skip(n);
    }
    let committed = !out.contains("NOTHING_TO_COMMIT");
    if !committed {
        let n = "nothing to commit — no deliverable files landed in the shared workspace and no code/design changes were applied to the repo this run".to_string();
        step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
        return skip(n);
    }
    let sha = out.lines().rev().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string()).unwrap_or_default();

    // PR title/body from the dev persona — written to files to dodge shell quoting
    let (dname, dtitle, drules, dmodel) = dev;
    let system = format!(
        "{drules}\n\nYou are {dname}, {dtitle}, closing a team mission on project '{project_name}'. \
Write the pull request for this mission's deliverables. Reply with EXACTLY this shape:\n\
TITLE: <one line, ≤72 chars, same language as the mission>\n\
BODY:\n<markdown ≤180 words: what the mission delivered, what is added under missions/{run_id}/, and the QA evidence in one line>"
    );
    let user = format!("## Mission\n{task}\n\n## Added under missions/{run_id}/\nThe team's per-role deliverable markdown files for this mission.\n\nWrite TITLE: and BODY:.");
    let (title, body) = match dmodel.as_deref() {
        Some(m) => match llm_step(app, run_id, dev_role, "pr", m, &system, &user, 400).await {
            Ok(Some(t)) => parse_pr_text(&t, task, run_id),
            Ok(None) => {
                let n = "run stopped at the budget checkpoint — nothing was pushed".to_string();
                step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
                return skip(n);
            }
            Err(_) => (format!("Mission {run_id}: {}", one_line(task, 60)), task.to_string()),
        },
        None => (format!("Mission {run_id}: {}", one_line(task, 60)), task.to_string()),
    };
    // PR text is model output — write it locally (0600) instead of heredoc'ing
    // it through the shell, so an injected terminator line cannot execute.
    let title_path = std::env::temp_dir().join(format!("aap-pr-title-{run_id}.txt"));
    let body_path = std::env::temp_dir().join(format!("aap-pr-body-{run_id}.md"));
    let _ = write_atomic_private(&title_path, &title.replace('\r', ""));
    let _ = write_atomic_private(&body_path, &body.replace('\r', ""));
    let title_arg = hostexec::shq(&title_path.to_string_lossy());
    let body_arg = hostexec::shq(&body_path.to_string_lossy());

    // Auth gate → push → PR. Missing auth first triggers the in-mission device
    // flow (need-human chat with the code) — the run waits for the user to
    // approve in the browser, then push + PR continue on the spot. Whatever
    // still fails after that is a skip with the honest reason (nothing fake was
    // created); a failed push/PR is an error with the real output.
    let (code, _) = app.exec_in(&cid, "command -v gh >/dev/null 2>&1 || exit 127; gh auth status >/dev/null 2>&1")
        .await
        .unwrap_or((127, String::new()));
    if code != 0 {
        if code == 127 {
            let n = "gh CLI not installed on this machine — brew install gh to open PRs".to_string();
            step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
            return skip(n);
        }
        match try_in_mission_github_auth(app, run_id, dev_role, &cid).await {
            GhAuthOutcome::Connected(_) => { /* auth landed — fall through to push */ }
            GhAuthOutcome::Stopped => {
                let n = "stopped while waiting for GitHub authorization".to_string();
                step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
                return skip(n);
            }
            GhAuthOutcome::RepliedUnauthed => {
                let n = format!("gh still not authenticated after your chat reply — เชื่อม GitHub ให้เครื่องนี้ที่หน้า Containers/Team → connector (login ผ่าน browser หรือวาง token เป็นทางสำรอง) แล้ว re-run (branch '{branch}' with the mission commit exists locally in the container)");
                step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
                return skip(n);
            }
            GhAuthOutcome::Ended => {
                let n = format!("GitHub authorization did not complete in time — เชื่อม GitHub ให้เครื่องนี้ที่หน้า Containers/Team → connector แล้ว re-run (branch '{branch}' with the mission commit exists locally in the container)");
                step_transition(app, run_id, dev_role, "pr", "skipped", &n).await;
                return skip(n);
            }
        }
    }
    let (code, out) = app.exec_in(&cid, &format!("cd '{repo_path}' && git push -q -u origin '{branch}' 2>&1")).await
        .unwrap_or((-1, "exec failed".into()));
    if code != 0 {
        let n = format!("pushing branch '{branch}' failed (exit {code}): {}", one_line(&out, 400));
        step_transition(app, run_id, dev_role, "pr", "error", &n).await;
        return PrOutcome { status: "error".into(), url: String::new(), branch, note: n };
    }
    let (code, out) = app.exec_in(&cid, &format!(
        "cd '{repo_path}' && gh pr create --head '{branch}' --title \"$(cat {title_arg})\" --body-file {body_arg} 2>&1"
    )).await.unwrap_or((-1, "exec failed".into()));
    let url = extract_pr_url(&out);
    if let Some(u) = url.filter(|_| code == 0) {
        let report = format!(
            "✅ Pull request opened: {u}\n\n- Branch `{branch}` (commit `{sha}`)\n- Contents: everything the team changed — `missions/{run_id}/*.md` deliverables + any code/design files applied via FILES blocks\n- Changed paths:\n```\n{}\n```\n- Repo: {repo_url}\n\n---\n{body}",
            out.lines().filter(|l| l.starts_with("??") || (l.len() > 2 && l.as_bytes()[1] == b' ')).take(15).collect::<Vec<_>>().join("\n"),
        );
        step_transition(app, run_id, dev_role, "pr", "done", &report).await;
        return PrOutcome { status: "done".into(), url: u, branch, note: report };
    }
    if out.to_lowercase().contains("already exists") {
        let (c2, o2) = app.exec_in(&cid, &format!("cd '{repo_path}' && gh pr view '{branch}' --json url -q .url 2>&1")).await
            .unwrap_or((-1, String::new()));
        if c2 == 0 {
            if let Some(u) = extract_pr_url(&o2) {
                let report = format!("✅ Pull request (already existed): {u}\n\n- Branch `{branch}` (commit `{sha}`)\n- Repo: {repo_url}");
                step_transition(app, run_id, dev_role, "pr", "done", &report).await;
                return PrOutcome { status: "done".into(), url: u, branch, note: report };
            }
        }
    }
    let n = format!("gh pr create failed (exit {code}): {}", one_line(&out, 400));
    step_transition(app, run_id, dev_role, "pr", "error", &n).await;
    PrOutcome { status: "error".into(), url: String::new(), branch, note: n }
}

/// Push one message into a demo discussion (and clear the typing indicator).
async fn demo_say(app: &App, run_id: &str, disc_id: &str, from: &str, text: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(disc) = store.runs.iter_mut().find(|r| r.id == run_id)
        .and_then(|r| r.discussions.iter_mut().find(|d| d.id == disc_id))
    {
        disc.messages.push(MeetingMessage { from: from.into(), text: text.into(), at: now_secs() });
        disc.answering = None;
    }
    save_runs(&store);
}

/// Mark who is about to speak (live typing indicator in the UI).
async fn demo_answering(app: &App, run_id: &str, disc_id: &str, role: &str) {
    let mut store = app.store.lock().unwrap();
    if let Some(disc) = store.runs.iter_mut().find(|r| r.id == run_id)
        .and_then(|r| r.discussions.iter_mut().find(|d| d.id == disc_id))
    {
        disc.answering = Some(role.into());
    }
    save_runs(&store);
}

/// The acceptance demo: a scripted meeting-kind discussion — QA presents the
/// e2e evidence, the Dev presents the REAL PR delivery, then the PO checks
/// every acceptance criterion and issues the final VERDICT.
async fn run_demo_session(
    app: &App, run_id: &str, task: &str, project_name: &str, dev_role: &str,
    qa: &(String, String, String, Option<String>),
    dev: &(String, String, String, Option<String>),
    po: &(String, String, String, Option<String>),
    pr: &PrOutcome,
) -> Option<Acceptance> {
    step_transition(app, run_id, "po", "demo", "working", "").await;
    {
        let mut store = app.store.lock().unwrap();
        if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
            run.phase = "demo".into();
            run.discussions.push(Discussion {
                id: format!("d-{:03}", run.discussions.len() + 1),
                kind: "demo".into(),
                from: "orchestrator".into(),
                to: vec!["po".into()],
                topic: "Acceptance demo — QA evidence · Dev delivery · PO acceptance".into(),
                status: "answering".into(),
                answering: None,
                messages: Vec::new(),
                round: 1,
                created_at: now_secs(),
            });
        }
        save_runs(&store);
    }
    let disc_id = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .and_then(|r| r.discussions.iter().rev().find(|d| d.kind == "demo"))
            .map(|d| d.id.clone())?
    };
    let qa_output = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .and_then(|r| r.steps.iter().find(|s| s.role == "qa" && s.kind == "work"))
            .map(|s| s.output.clone()).unwrap_or_default()
    };
    let po_output = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .and_then(|r| r.steps.iter().find(|s| s.role == "po" && s.kind == "work"))
            .map(|s| s.output.clone()).unwrap_or_default()
    };

    demo_say(app, run_id, &disc_id, "orchestrator",
        "🎬 Demo รับมอบงาน — QA แสดงหลักฐานการทดสอบ, Dev ส่งมอบ PR จริง, แล้ว PO ตรวจนับ acceptance criteria ทีละข้อ").await;

    // QA presents the e2e evidence
    let (qname, _qt, qrules, qmodel) = qa;
    demo_answering(app, run_id, &disc_id, "qa").await;
    let qsys = format!(
        "{qrules}\n\nYou are {qname} presenting your test evidence in the acceptance demo for the mission on '{project_name}'. \
Present concisely (≤180 words): what was verified, the concrete evidence from your deliverable (test cases / results), and residual risks. Same language as the mission."
    );
    let quser = format!("## Mission\n{task}\n\n## Your QA deliverable\n{}\n\nPresent the evidence.", qa_output.chars().take(1600).collect::<String>());
    let qa_msg = match qmodel.as_deref() {
        Some(m) => match llm_step(app, run_id, "qa", "", m, &qsys, &quser, 500).await {
            Ok(Some(t)) => t,
            Ok(None) => return None,
            Err(e) => format!("(QA could not present: {})", e.1),
        },
        None => "(no model configured for QA)".into(),
    };
    demo_say(app, run_id, &disc_id, "qa", &qa_msg).await;

    // Dev presents the REAL delivery (facts only — never invented URLs)
    let (dname, _dt, drules, dmodel) = dev;
    demo_answering(app, run_id, &disc_id, dev_role).await;
    let dsys = format!(
        "{drules}\n\nYou are {dname} presenting the REAL delivery in the acceptance demo for the mission on '{project_name}'. \
State what was shipped — branch, pull request — using EXACTLY the facts given to you; never invent or alter URLs. ≤150 words, same language as the mission."
    );
    let duser = format!(
        "## Mission\n{task}\n\n## Your real delivery (facts of record)\n- {}\n\nPresent the delivery.",
        pr.describe()
    );
    let dev_msg = match dmodel.as_deref() {
        Some(m) => match llm_step(app, run_id, dev_role, "", m, &dsys, &duser, 400).await {
            Ok(Some(t)) => t,
            Ok(None) => return None,
            Err(e) => format!("(Dev could not present: {})", e.1),
        },
        None => "(no model configured for the Dev)".into(),
    };
    demo_say(app, run_id, &disc_id, dev_role, &dev_msg).await;

    // Machine-truth footer: exact URLs verbatim, regardless of LLM wording
    let footer = format!("📦 delivery of record — PR: {}", pr.describe());
    demo_say(app, run_id, &disc_id, "orchestrator", &footer).await;

    // PO checks every acceptance criterion, then issues the verdict
    let (pname, _pt, prules, pmodel) = po;
    demo_answering(app, run_id, &disc_id, "po").await;
    let psys = format!(
        "{prules}\n\nYou are {pname} running the acceptance check in the demo for the mission on '{project_name}'. \
Check EVERY acceptance criterion from your own mission output ONE BY ONE: quote it briefly, mark ✅ or ❌, one SHORT line of evidence each \
(map evidence from QA's tests and the Dev's real delivery; a criterion with no evidence is ❌) — keep each check to ONE line so you never run out of space. \
The VERY LAST line must be exactly `VERDICT: PASS` or `VERDICT: FAIL` — these exact English words even when the mission is in another language. \
Write the checks in the same language as the mission."
    );
    let puser = format!(
        "## Mission\n{task}\n\n## Your acceptance criteria (your own deliverable)\n{}\n\n## QA evidence\n{}\n\n## Dev delivery + delivery of record\n{}\n\n{}",
        po_output.chars().take(1600).collect::<String>(), qa_msg, dev_msg, footer
    );
    let po_msg = match pmodel.as_deref() {
        Some(m) => match llm_step(app, run_id, "po", "", m, &psys, &puser, 1600).await {
            Ok(Some(t)) => Ok(t),
            Ok(None) => return None,
            Err(e) => Err(e),
        },
        None => Err(err(StatusCode::BAD_REQUEST, "No model configured for the PO")),
    };
    match po_msg {
        Ok(po_msg) if !po_msg.is_empty() => {
            demo_say(app, run_id, &disc_id, "po", &po_msg).await;
            let (verdict, summary) = match parse_verdict(&po_msg) {
                Some(v) => (v, po_msg.chars().take(600).collect::<String>()),
                None => ("fail".to_string(), format!("{}\n\n(PO's verdict line missing — treated as FAIL)", po_msg.chars().take(500).collect::<String>())),
            };
            let acceptance = Acceptance { verdict: verdict.clone(), summary: summary.clone() };
            {
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    run.acceptance = Some(acceptance.clone());
                    if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                        disc.status = "resolved".into();
                        disc.answering = None;
                    }
                }
                save_runs(&store);
            }
            let report = format!(
                "{} Acceptance: {}\n\n{}\n\n---\n{}",
                if verdict == "pass" { "✅" } else { "❌" },
                verdict.to_uppercase(),
                summary,
                pr.describe()
            );
            step_transition(app, run_id, "po", "demo", "done", &report).await;
            if let Some((cid, _)) = app.agent_container("po").await {
                let _ = write_deliverable(app, &cid, run_id, "demo", &report).await;
            }
            Some(acceptance)
        }
        Err(e) => {
            demo_say(app, run_id, &disc_id, "orchestrator", &format!("⚠️ PO could not run the acceptance check: {}", e.1)).await;
            let acceptance = Acceptance { verdict: "fail".into(), summary: format!("PO acceptance check failed: {}", e.1) };
            {
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    run.acceptance = Some(acceptance.clone());
                    if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                        disc.status = "resolved".into();
                        disc.answering = None;
                    }
                }
                save_runs(&store);
            }
            step_transition(app, run_id, "po", "demo", "error", &format!("PO acceptance check failed: {}", e.1)).await;
            Some(acceptance)
        }
        Ok(_) => {
            demo_say(app, run_id, &disc_id, "orchestrator", "⚠️ PO returned an empty verdict — treated as FAIL").await;
            let acceptance = Acceptance { verdict: "fail".into(), summary: "PO returned an empty verdict — treated as FAIL".into() };
            {
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    run.acceptance = Some(acceptance.clone());
                    if let Some(disc) = run.discussions.iter_mut().find(|d| d.id == disc_id) {
                        disc.status = "resolved".into();
                        disc.answering = None;
                    }
                }
                save_runs(&store);
            }
            step_transition(app, run_id, "po", "demo", "error", "PO returned an empty verdict").await;
            Some(acceptance)
        }
    }
}

/// llm_max with retries — provider hiccups (rate limits under load) and
/// reasoning models that spend the whole budget on thinking would otherwise
/// stall the relay or the demo verdict with an empty answer. A token-cap empty
/// retries once with a doubled budget (room for visible text after the
/// thinking); transient upstream errors back off; config errors fail fast.
async fn llm_retry_usage(app: &App, model: &str, system: &str, user: &str, max: u32) -> Result<(String, LlmUsage), ApiError> {
    let mut budget = max;
    let mut usage = LlmUsage::default();
    let mut last_err: Option<ApiError> = None;
    // 5 attempts with growing backoff (~20s of waiting total) — provider blips
    // (5xx, rate limits, even transient auth flaps that surface as 401) must
    // not kill a whole mission step by step. Hard misconfiguration still fails
    // fast on the first attempt below.
    for attempt in 0..5u32 {
        if attempt > 0 { tokio::time::sleep(std::time::Duration::from_secs(2 * attempt as u64)).await; }
        match app.llm_max_usage(model, system, user, budget).await {
            Ok((t, u)) if !t.trim().is_empty() => {
                usage.input_tokens += u.input_tokens;
                usage.output_tokens += u.output_tokens;
                return Ok((t, usage));
            }
            Ok((_, u)) => {
                usage.input_tokens += u.input_tokens;
                usage.output_tokens += u.output_tokens;
                last_err = Some(err(StatusCode::BAD_GATEWAY, format!("model '{model}' returned an empty answer")));
            }
            Err(e) => {
                if attempt == 0 && budget < 8000 && e.1.contains("token cap") {
                    budget = (budget * 2).min(8000); // thinking ate the budget — leave room for the answer
                } else if e.0.as_u16() == 429 || e.0.as_u16() == 502 {
                    last_err = Some(e); // transient — back off and try again
                } else {
                    return Err(e); // misconfiguration or a hard refusal won't heal on retry
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| err(StatusCode::BAD_GATEWAY, format!("model '{model}' returned an empty answer after 3 attempts"))))
}

/// (name, title, rules, model) for a role, straight from the persona store —
/// shared by the relay engine and single-step retry.
fn persona_of(app: &App, role: &str) -> (String, String, String, Option<String>) {
    let p = { app.store.lock().unwrap().personas.iter().find(|p| p.role == role).cloned() };
    match p {
        Some(p) => {
            let model = app.model_for_persona(Some(&p));
            (p.name, p.title, p.rules_md, model)
        }
        None => (role.to_string(), String::new(), String::new(), None),
    }
}

/// Clone/refresh the project repo into the shared workspace directory through
/// the FIRST agent's session. None = no agent could be started at all (the
/// run proceeds text-only); Some(Err) = a session was there but the clone
/// failed. Shared by the relay engine and single-step retry.
async fn ensure_team_repo(app: &App, roles: &[String], repo_url: &str) -> Option<Result<String, ApiError>> {
    for role in roles {
        if let Some((cid, _)) = app.agent_container(role).await {
            return Some(app.ensure_repo(&cid, repo_url).await);
        }
    }
    None
}

/// The repo line injected into every work prompt when the team workspace has
/// the project repo checked out.
fn team_repo_line(repo_path: &Option<String>) -> String {
    repo_path.as_deref()
        .map(|p| format!(" The project repository is already cloned in the team workspace at {p} — when your part involves code or files, work against that repo's real files (cite real paths from it); all file changes go through this repo only."))
        .unwrap_or_default()
}

/// Where a project's documents are materialized for the agents, relative to
/// the shared workspace root.
fn docs_workspace_dir(project_id: &str) -> std::path::PathBuf {
    hostexec::workspace_dir().join("project-docs").join(project_id)
}

/// Sanitize a title/filename into a safe single path component (no separators,
/// quotes or control chars; bounded length; never empty).
fn safe_doc_name(name: &str) -> String {
    let cleaned: String = std::path::Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | '"' | '\'' | '`' | '\0'))
        .take(80)
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() { "doc".into() } else { trimmed.to_string() }
}

/// Write every document of a project into the shared agent workspace:
/// INDEX.md (grouped by folder) plus one file per doc (markdown inline,
/// binaries copied from docs-files/). The directory is wiped first so deleted
/// documents never linger as stale agent-visible files. Empty space → the
/// directory is removed entirely. Best effort — a workspace hiccup must not
/// fail the API call.
fn materialize_project_docs(store: &Store, project_id: &str) -> Option<std::path::PathBuf> {
    let docs = project_docs_sorted(store, project_id);
    let dir = docs_workspace_dir(project_id);
    if docs.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    }
    if std::fs::remove_dir_all(&dir).is_err() && dir.exists() {
        return None;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }

    let project_name = store.projects.iter().find(|p| p.id == project_id).map(|p| p.name.clone()).unwrap_or_default();
    let mut index = format!(
        "# Project documents — {project_name} ({project_id})\n\n\
         Materialized copies of the team's document space (requirements, specs, analysis).\n\
         Markdown files carry the full content; binary files (PDF/docx/…) are stored as-is —\n\
         relay teammates see them via the mission prompt only, an agent working in this\n\
         workspace can open them directly.\n"
    );
    let mut written: Vec<(String, String, String)> = Vec::new(); // (folder, filename, title)
    for doc in &docs {
        let filename = match &doc.file {
            Some(f) => format!("{}-{}", doc.id, safe_doc_name(&f.name)),
            None => format!("{}-{}.md", doc.id, safe_doc_name(&doc.title)),
        };
        let path = dir.join(&filename);
        let ok = match &doc.file {
            Some(f) => std::fs::copy(docs_files_dir().join(&doc.id).join(&f.name), &path).is_ok(),
            None => std::fs::write(&path, &doc.content_md).is_ok(),
        };
        if ok {
            written.push((doc.folder.clone(), filename.clone(), doc.title.clone()));
        }
    }
    let mut last_folder = String::new();
    for (folder, filename, title) in &written {
        if folder != &last_folder {
            index.push_str(&format!("\n## {folder}\n"));
            last_folder = folder.clone();
        }
        index.push_str(&format!("- `{filename}` — {title}\n"));
    }
    let _ = std::fs::write(dir.join("INDEX.md"), index);
    Some(dir)
}

/// Materialize the project's documents and build the two prompt fragments:
/// `(docs_section, docs_pointer_line)` — both empty when the space is empty.
/// The section always carries the full index; markdown bodies follow until the
/// total budget is spent (per-doc cap first, then the shared cap).
fn prepare_project_docs(store: &Store, project_id: &str) -> (String, String) {
    let docs = project_docs_sorted(store, project_id);
    if docs.is_empty() {
        return (String::new(), String::new());
    }
    let dir = materialize_project_docs(store, project_id);
    let pointer = dir.as_deref().map(|d| format!(
        " The team's document space (requirements/BA/SA specs) is materialized at {} — INDEX.md lists every document; consult them whenever your part touches the project's requirements or specs.",
        d.display()
    )).unwrap_or_default();

    let mut section = format!(
        "\n\n## Project documents\nThe team maintains a document space (PO/BA/SA and general documents). Read what is relevant to YOUR part before delivering.\n"
    );
    let mut last_folder = String::new();
    for doc in &docs {
        if doc.folder != last_folder {
            section.push_str(&format!("\n### {}\n", doc.folder));
            last_folder = doc.folder.clone();
        }
        match &doc.file {
            Some(f) => section.push_str(&format!("- **{}** — uploaded file `{}` ({:.1} KB)\n", doc.title, f.name, f.size as f64 / 1024.0)),
            None => section.push_str(&format!("- **{}**\n", doc.title)),
        }
    }
    let open_comments: Vec<&DocComment> = store.doc_comments.iter()
        .filter(|c| c.project_id == project_id && c.status == "open")
        .collect();
    if !open_comments.is_empty() {
        section.push_str("\n#### Open review comments — address these explicitly in your deliverable\n");
        for c in open_comments.iter().take(20) {
            let doc_title = docs.iter().find(|d| d.id == c.doc_id).map(|d| d.title.as_str()).unwrap_or(c.doc_id.as_str());
            let quote = if c.quote.trim().is_empty() {
                String::new()
            } else {
                format!(" (on «{}»)", c.quote.chars().take(120).collect::<String>())
            };
            section.push_str(&format!(
                "- **{doc_title}**{quote} — {}: {}\n",
                c.author, c.body.chars().take(300).collect::<String>()
            ));
        }
    }
    let mut budget = DOCS_INJECT_MAX_CHARS;
    for doc in &docs {
        if doc.file.is_some() || doc.content_md.trim().is_empty() { continue; }
        if budget < 400 { break; }
        section.push_str(&format!("\n#### {} — full content\n", doc.title));
        let body: String = doc.content_md.chars().take(DOC_INJECT_MAX_CHARS).collect();
        if doc.content_md.chars().count() > DOC_INJECT_MAX_CHARS {
            section.push_str(&body);
            section.push_str("\n[…truncated]\n");
        } else {
            section.push_str(&body);
            section.push('\n');
        }
        budget = budget.saturating_sub(body.chars().count() + 64);
    }
    (section, pointer)
}

/// Shared work prompt: deliver YOUR part; ASK only when genuinely blocked.
/// `files` = this teammate ships real repo artifacts (dev/UX with a repo) —
/// their reply must end with a FILES block the orchestrator applies.
/// Goal ancestry + org-lite line for a persona's prompt: the project's standing
/// "why" and the manager this role reports to. Empty when neither is set.
fn goal_ancestry_line(app: &App, run_id: &str, role: &str) -> String {
    let store = app.store.lock().unwrap();
    let Some(run) = store.runs.iter().find(|r| r.id == run_id) else { return String::new() };
    let goal = if !run.goal.trim().is_empty() {
        run.goal.clone()
    } else {
        store.projects.iter().find(|p| p.id == run.project_id).map(|p| p.goal.clone()).unwrap_or_default()
    };
    let manager = store.personas.iter().find(|p| p.role == role).map(|p| p.reports_to.clone()).unwrap_or_default();
    let mut out = String::new();
    if !goal.trim().is_empty() {
        out.push_str(&format!(
            "\n\n## Project goal — the WHY behind every task\n{goal}\nEvery deliverable must serve this goal; if the task conflicts with it, raise that in your ## ASK."
        ));
    }
    if !manager.is_empty() {
        let (mname, mtitle) = store.personas.iter().find(|p| p.role == manager)
            .map(|p| (p.name.clone(), p.title.clone()))
            .unwrap_or((manager.clone(), String::new()));
        out.push_str(&format!(
            "\nYou report to {mname} ({manager}{}) — align your output with the brief above yours and address blockers to them in your ## ASK.",
            if mtitle.is_empty() { String::new() } else { format!(", {mtitle}") }
        ));
    }
    out
}

fn work_system(rules: &str, name: &str, title: &str, files: bool, project_name: &str, repo_line: &str, docs_line: &str, goal_line: &str, run_id: &str) -> String {
    let files_line = if files {
        format!("\nYou work on the REAL repository (already checked out in the team workspace). IMPLEMENT, don't just describe: end your reply with a section exactly titled \"## FILES\" listing every new or changed file as `### <repo-relative-path>` followed by ONE fenced code block with the COMPLETE file content (full file, never a diff — keep the change small and focused, max ~6 files, matching the repo's existing style and framework; UX design artifacts go under `design/{run_id}/`, e.g. tokens.json / wireframe.html / style.md). Anything not listed in ## FILES will NOT reach the repository. Keep the prose part of your reply as the rationale.\n")
    } else {
        String::new()
    };
    format!(
        "{rules}\n\nYou are {name}, {title}, one member of an AI agent team on project '{project_name}'. \
The user gave the team ONE task. The team works together like a real software team: the PO opens the mission, the BA analyzes the business side, the SA turns it into the system spec that briefs UX/UI, Dev and QA each directly, then every specialist delivers their part against that spec; after QA verifies, the team ships for real — the first Dev opens a pull request with everything the team produced, then the PO runs an acceptance demo against the mission's acceptance criteria and issues the final VERDICT.{repo_line}{docs_line}{goal_line} \
Treat earlier teammates' output as your input — do YOUR part only, do not repeat or redo teammates' work; build on it, fill the gaps your expertise covers. \
Reply with your concrete work deliverable in markdown (tight headings, lists, tables or code where useful — no filler, no apologies).{files_line} \
Answer in the same language the task is written in. Keep it under ~450 words (the ## FILES section does not count toward the limit). \
If something genuinely blocks your part or is unclear, you may end your reply with a section exactly titled \"## ASK\" containing a line \"to: role1, role2\" (teammates who must answer — \"all\" for the whole team, \"human\" for the user) and 1-3 concise questions. Use it sparingly: only when you cannot do your part correctly without the answer. Address \"human\" ONLY when the missing piece is information or a decision that neither you nor any teammate can produce (credentials, business intent, external approval) — the whole team pauses until the user replies."
    )
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

    // Bot-on-this-machine rule, team edition: before the relay starts, the
    // first agent clones the project repo into the shared workspace — every
    // teammate then works on that one real working tree, and all file changes
    // go through the repo only.
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
        let team: Vec<String> = roles.iter().map(|(r, _, _)| r.clone()).collect();
        match ensure_team_repo(&app, &team, &repo_url).await {
            Some(Ok(path)) => (Some(path), None),
            Some(Err(e)) => (None, Some(e.1)),
            // no agent container running — the run proceeds text-only, as before
            None => (None, None),
        }
    };
    let repo_line = team_repo_line(&repo_path);
    let repo_note = repo_error.map(|e| format!("\n\n## Note from the orchestrator\nThe project repo could not be cloned into the team workspace ({e}) — deliver text deliverables only this run."));
    // The project's document space, materialized into the workspace for this
    // run — the section rides every relay prompt (budgeted), the pointer line
    // sits in the system prompt.
    let (docs_section, docs_line) = {
        let store = app.store.lock().unwrap();
        prepare_project_docs(&store, &project_id)
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
        let (role, _name, title) = (role.clone(), name.clone(), title.clone());
        let (pname, _ptitle, rules, model) = persona_of(&app, &role);

        // step → working (records the model this step will run with, even if it later errors)
        {
            let mut store = app.store.lock().unwrap();
            if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role && s.kind == "work")) {
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
                for s in run.steps.iter().take_while(|s| !(s.role == role && s.kind == "work")) {
                    if s.status == "done" && !s.output.is_empty() {
                        // FILES listings are stripped — teammates need the summary,
                        // not full file bodies (the repo tree has the real files)
                        let brief: String = strip_files(&s.output).chars().take(1400).collect();
                        handoff.push_str(&format!("\n### {} — {} (done)\n{}\n", s.name, s.title, brief));
                    }
                }
            }
        }

        // dev/UX teammates with a repo ship real files — their reply may carry a
        // FILES block, which needs a far larger completion budget than prose
        let ships_files = repo_path.is_some() && (role.starts_with("dev") || role.starts_with("ux"));
        let goal_line = goal_ancestry_line(&app, &run_id, &role);
        let system = work_system(&rules, &pname, &title, ships_files, &project_name, &repo_line, &docs_line, &goal_line, &run_id);
        let first_note = repo_note.as_deref().unwrap_or("");
        let user = if handoff.is_empty() {
            format!("## Task from the user\n{task}{first_note}{docs_section}\n\nYou are the first teammate to answer. Deliver your part.")
        } else {
            format!("## Task from the user\n{task}{docs_section}\n\n## What teammates before you already produced\n{handoff}\n\nNow deliver YOUR part ({title}).")
        };

        let cap = if ships_files { 6000 } else { 1400 };
        let (harness, hcmd) = persona_harness(&app, &role);
        let external = harness != "native";
        let result = if external {
            harness_step(&app, &run_id, &role, &harness, &hcmd, model.as_deref().unwrap_or(""), &system, &user).await
        } else {
            match model.as_deref() {
                Some(m) => llm_step(&app, &run_id, &role, "work", m, &system, &user, cap).await,
                None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
            }
        };
        match result {
            Ok(Some(output)) if !output.is_empty() => {
                let mut clean = strip_ask(&output);
                if external {
                    mark_harness_step(&app, &run_id, &role, &harness);
                } else {
                    // External harnesses edit the repo directly — no FILES to apply.
                    apply_files_note(&app, repo_path.as_deref(), &role, &mut clean).await;
                }
                deliver_and_close(&app, &run_id, &role, &clean, None).await;
                if let Some((to, topic)) = parse_ask(&output) {
                    raise_discussion(&role, &to, &topic, 1);
                }
            }
            Ok(None) => { wind_down_or_pause(&app, &run_id); return; }
            Ok(Some(_)) => {
                let mut store = app.store.lock().unwrap();
                if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role && s.kind == "work")) {
                    step.status = "error".into();
                    step.output = "Model returned an empty answer".into();
                    step.finished_at = now_secs();
                }
                save_runs(&store);
            }
            Err(e) => {
                let mut store = app.store.lock().unwrap();
                if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role && s.kind == "work")) {
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
            let (fname, ftitle, ..) = persona_of(&app, &d.from);
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
                let (tname, ttitle, trules, tmodel) = persona_of(&app, target);
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
                        .and_then(|r| r.steps.iter().find(|s| s.role == d.from && s.kind == "work"))
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
                    Some(m) => llm_step(&app, &run_id, target, "", m, &system, &user, 350).await,
                    None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
                };
                let text = match answer {
                    Ok(Some(t)) if !t.is_empty() => t.trim().chars().take(900).collect::<String>(),
                    Ok(None) => { wind_down_or_pause(&app, &run_id); return; }
                    Ok(Some(_)) => "(empty answer)".into(),
                    Err(e) => format!("⚠️ could not answer: {}", e.1),
                };
                let mut store = app.store.lock().unwrap();
                if let Some(disc) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.discussions.iter_mut().find(|x| x.id == d.id)) {
                    disc.messages.push(MeetingMessage { from: target.clone(), text, at: now_secs() });
                }
                save_runs(&store);
            }

            // The asker revises their deliverable with the answers
            let (aname, atitle, arules, amodel) = persona_of(&app, &d.from);
            let (prev, msgs) = {
                let store = app.store.lock().unwrap();
                let run = match store.runs.iter().find(|r| r.id == run_id) { Some(r) => r, None => return };
                let prev: String = run.steps.iter().find(|s| s.role == d.from && s.kind == "work").map(|s| s.output.chars().take(1200).collect()).unwrap_or_default();
                let msgs = run.discussions.iter().find(|x| x.id == d.id).map(|x| x.messages.clone()).unwrap_or_default();
                (prev, msgs)
            };
            let answers = msgs.iter()
                .map(|m| {
                    let speaker = if m.from == "human" { "the user".to_string() } else if m.from == "orchestrator" { "orchestrator".to_string() } else { persona_of(&app, &m.from).0 };
                    format!("- **{}** ({}): {}", speaker, m.from, m.text)
                })
                .collect::<Vec<_>>().join("\n");
            {
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    if let Some(step) = run.steps.iter_mut().find(|s| s.role == d.from && s.kind == "work") { step.status = "working".into(); step.started_at = now_secs(); }
                    if let Some(disc) = run.discussions.iter_mut().find(|x| x.id == d.id) { disc.answering = Some(d.from.clone()); }
                }
                save_runs(&store);
            }
            // a dev/UX asker may re-emit their FILES block with fixes applied
            let rev_files = repo_path.is_some() && (d.from.starts_with("dev") || d.from.starts_with("ux"));
            let goal_line = goal_ancestry_line(&app, &run_id, &d.from);
            let system = work_system(&arules, &aname, &atitle, rev_files, &project_name, &repo_line, &docs_line, &goal_line, &run_id);
            let user = format!(
                "## Task from the user\n{task}\n\n## Your earlier deliverable\n{prev}\n\n## Your question to the team\n{}\n\n## Answers from the team\n{answers}\n\nRevise and resend YOUR full deliverable (same format rules, ≤450 words — re-emit the full \"## FILES\" section too if your files changed). If you are still blocked you may end with another \"## ASK\" section.",
                d.topic,
            );
            let (harness, hcmd) = persona_harness(&app, &d.from);
            let external = harness != "native";
            let result = if external {
                harness_step(&app, &run_id, &d.from, &harness, &hcmd, amodel.as_deref().unwrap_or(""), &system, &user).await
            } else {
                match amodel.as_deref() {
                    Some(m) => llm_step(&app, &run_id, &d.from, "work", m, &system, &user, if rev_files { 6000 } else { 1400 }).await,
                    None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
                }
            };
            match result {
                Ok(Some(output)) if !output.is_empty() => {
                    let mut clean = strip_ask(&output);
                    if external {
                        mark_harness_step(&app, &run_id, &d.from, &harness);
                    } else {
                        apply_files_note(&app, repo_path.as_deref(), &d.from, &mut clean).await;
                    }
                    deliver_and_close(&app, &run_id, &d.from, &clean, Some(meeting_round + 1)).await;
                    // The question as asked is answered either way; a still-blocked asker raises a NEW discussion.
                    match parse_ask(&output) {
                        Some((to, topic)) => { raise_discussion(&d.from, &to, &topic, meeting_round + 1); }
                        None => {}
                    }
                }
                Ok(None) => { wind_down_or_pause(&app, &run_id); return; }
                // Revision failed — keep the round-1 deliverable, it is still valid work
                _ => {
                    let mut store = app.store.lock().unwrap();
                    if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                        if let Some(step) = run.steps.iter_mut().find(|s| s.role == d.from && s.kind == "work") { step.status = "done".into(); step.finished_at = now_secs(); }
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

    // ---- Tail: after QA verifies — the dev opens a REAL pull request, then
    // the PO runs the acceptance demo ----
    let tail_gate = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id).map(|run| {
            run.steps.iter().any(|s| s.kind == "work" && s.role == "qa" && s.status == "done")
                && roles.iter().any(|(r, _, _)| r.starts_with("dev"))
                && roles.iter().any(|(r, _, _)| r == "po")
        }).unwrap_or(false)
    };
    let mut tail: Option<(PrOutcome, Option<Acceptance>)> = None;
    if tail_gate {
        if stop_requested(&app, &run_id) { finish_run(&app, &run_id, "stopped"); return; }
        // first dev role owns the PR — one branch, one working tree
        let dev_role = roles.iter().find(|(r, _, _)| r.starts_with("dev")).map(|(r, _, _)| r.clone()).unwrap();
        append_tail_steps(&app, &run_id, &dev_role, "po").await;
        let dev_persona = persona_of(&app, &dev_role);
        // Spending checkpoint before the tail: never commit/push for a run
        // whose budget is already exhausted.
        if !guard_budget(&app, &run_id).await { return; }
        // run_pr_stage owns the review gate: it stages the exact diff, waits
        // for the human's decision, then commits/pushes. Retries go through
        // the same path, so there is no bypass.
        let pr = run_pr_stage(&app, &run_id, &dev_role, &repo_url, &task, &project_name, &dev_persona).await;
        if stop_requested(&app, &run_id) || !run_is_live(&app, &run_id) {
            finish_run(&app, &run_id, "stopped");
            return;
        }
        let qa_persona = persona_of(&app, "qa");
        let po_persona = persona_of(&app, "po");
        let acceptance = run_demo_session(&app, &run_id, &task, &project_name, &dev_role,
            &qa_persona, &dev_persona, &po_persona, &pr).await;
        if stop_requested(&app, &run_id) || !run_is_live(&app, &run_id) {
            finish_run(&app, &run_id, "stopped");
            return;
        }
        tail = Some((pr, acceptance));
    }

    // ---- PO closes the mission with one summary ----
    if roles.iter().any(|(r, _, _)| r == "po") {
        let (pname, _ptitle, prules, pmodel) = persona_of(&app, "po");
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
        let tail_line = match &tail {
            Some((pr, acc)) => format!(
                "\n\n## Real delivery\n- {}\n\n## Acceptance verdict\n{}",
                pr.describe(),
                acc.as_ref().map(|a| format!("VERDICT: {} — {}", a.verdict.to_uppercase(), a.summary.chars().take(300).collect::<String>()))
                    .unwrap_or_else(|| "(the demo did not produce a verdict)".into())
            ),
            None => String::new(),
        };
        let user = format!("## Mission\n{task}\n\n## Deliverables\n{deliverables}\n\n## Meetings\n{meetings}{tail_line}\n\nWrite the mission summary.");
        let result = match pmodel.as_deref() {
            Some(m) => llm_step(&app, &run_id, "po", "", m, &system, &user, 500).await,
            None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
        };
        match result {
            Ok(None) => { wind_down_or_pause(&app, &run_id); return; }
            Ok(Some(summary)) if !summary.is_empty() => {
                if let Some((cid, _)) = app.agent_container("po").await {
                    let _ = write_deliverable(&app, &cid, &run_id, "summary", &summary).await;
                }
                let mut store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter_mut().find(|r| r.id == run_id) {
                    run.summary = Some(summary);
                }
                save_runs(&store);
            }
            _ => {}
        }
    }

    // ---- Close the run, then let the PO decide the next loop iteration ----
    // finish_run is the single close gate: it refuses to overwrite a run that
    // was already stopped/closed (budget stop or user Stop), and it closes any
    // step left "working" so the UI never shows a zombie.
    let all_error = {
        let store = app.store.lock().unwrap();
        match store.runs.iter().find(|r| r.id == run_id) {
            Some(run) => run.steps.iter().all(|s| s.status == "error"),
            None => return,
        }
    };
    finish_run(&app, &run_id, if all_error { "error" } else { "done" });
    // Only a genuinely completed run may spawn the next loop iteration; a
    // budget/stop-closed run leaves the chain ended.
    let closed_status = app.store.lock().unwrap().runs.iter().find(|r| r.id == run_id).map(|r| r.status.clone());
    if closed_status.as_deref() != Some("done") { return; }

    // Loop mode: the PO looks at the whole chain so far and either writes the
    // next iteration's task or declares the goal done.
    let (loop_mode, iteration) = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id).map(|r| (r.loop_mode, r.iteration)).unwrap_or((false, 1))
    };
    if loop_mode && !all_error && !stop_requested(&app, &run_id) && iteration < MAX_LOOP_ITERATIONS {
        let (pname, _ptitle, prules, pmodel) = persona_of(&app, "po");
        if let Some(model) = pmodel {
            let (chain, acc_text) = {
                let store = app.store.lock().unwrap();
                let chain = store.runs.iter()
                    .filter(|r| r.project_id == project_id && r.loop_mode)
                    .map(|r| format!("### Iteration {} — {}\nSummary: {}", r.iteration, r.task, r.summary.as_deref().map(|s| s.chars().take(500).collect::<String>()).unwrap_or_else(|| "(none)".into())))
                    .collect::<Vec<_>>().join("\n\n");
                let acc_text = store.runs.iter().find(|r| r.id == run_id)
                    .and_then(|r| r.acceptance.clone())
                    .map(|a| format!("VERDICT: {} — {}", a.verdict.to_uppercase(), a.summary.chars().take(300).collect::<String>()))
                    .unwrap_or_else(|| "(none — no acceptance demo ran this iteration)".into());
                (chain, acc_text)
            };
            let system = format!(
                "{prules}\n\nYou are {pname}, the PO of an AI team running in a LOOP on project '{project_name}'. \
The loop's standing goal is the ORIGINAL task. After each iteration you decide what the team should do next. \
The last iteration's acceptance verdict from the demo session is listed under 'Acceptance verdict'. If it is FAIL you MUST reply with a concrete fix task for the next iteration — replying DONE is not allowed. If it is PASS you may reply DONE when the standing goal is fully achieved. \
Reply with EITHER the concrete task for the next iteration (one sentence, same language as the goal, ≤60 words — build on what is already done, do not repeat it) OR exactly `DONE` when the goal is achieved and no further iteration adds value."
            );
            let user = format!("## Standing goal\n{task}\n\n## Iterations so far\n{chain}\n\n## Acceptance verdict\n{acc_text}\n\nDecide: the next iteration's task, or `DONE`.");
            if let Ok(Some(next)) = llm_step(&app, &run_id, "po", "", &model, &system, &user, 200).await {
                let next = next.trim().trim_matches('`').to_string();
                if !next.is_empty() && !next.eq_ignore_ascii_case("done") && next.len() < 600 {
                    let next_task = next.lines().last().unwrap_or(&next).to_string();
                    if let Ok(child) = spawn_run_with(&app, &project_id, &next_task, true, iteration + 1, "loop", None) {
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

/// Re-run ONE step of a closed run in place — the per-item retry path
/// (POST /runs/{id}/steps/{role}/{kind}/retry). Everything else the mission
/// produced stays exactly as it is: teammates' done deliverables, meetings,
/// tail outcomes. Only the failed step's own work is redone, against the
/// CURRENT state (persona/model config, containers, repo).
async fn retry_step_engine(app: App, run_id: String, role: String, kind: String) {
    let (project_name, project_id, task) = {
        let store = app.store.lock().unwrap();
        match store.runs.iter().find(|r| r.id == run_id) {
            Some(r) => (r.project_name.clone(), r.project_id.clone(), r.task.clone()),
            None => return,
        }
    };
    let repo_url = {
        let store = app.store.lock().unwrap();
        store.projects.iter().find(|p| p.id == project_id)
            .or_else(|| store.projects.iter().find(|p| p.name == project_name))
            .map(|p| p.repo_url.clone())
            .unwrap_or_default()
    };
    let team: Vec<String> = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .map(|r| r.steps.iter().filter(|s| s.kind == "work").map(|s| s.role.clone()).collect())
            .unwrap_or_default()
    };

    // Same shared-workspace rule as the relay: the repo rides the first running
    // agent container; without one the step stays text-only.
    let repo_path: Option<String> = if repo_url.is_empty() { None } else {
        match ensure_team_repo(&app, &team, &repo_url).await {
            Some(Ok(p)) => Some(p),
            _ => None,
        }
    };
    let repo_line = team_repo_line(&repo_path);
    let (docs_section, docs_line) = {
        let store = app.store.lock().unwrap();
        prepare_project_docs(&store, &project_id)
    };

    match kind.as_str() {
        // One teammate's relay deliverable, rebuilt with the same handoff the
        // original relay pass gave them (done outputs of the steps before them).
        "work" => {
            let (pname, title, rules, model) = persona_of(&app, &role);
            let mut handoff = String::new();
            {
                let store = app.store.lock().unwrap();
                if let Some(run) = store.runs.iter().find(|r| r.id == run_id) {
                    for s in run.steps.iter().take_while(|s| !(s.role == role && s.kind == "work")) {
                        if s.status == "done" && !s.output.is_empty() {
                            let brief: String = strip_files(&s.output).chars().take(1400).collect();
                            handoff.push_str(&format!("\n### {} — {} (done)\n{}\n", s.name, s.title, brief));
                        }
                    }
                }
            }
            {
                // record the model this retry runs with (as the relay does)
                let mut store = app.store.lock().unwrap();
                if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role && s.kind == "work")) {
                    step.model = model.clone();
                }
                save_runs(&store);
            }
            let ships_files = repo_path.is_some() && (role.starts_with("dev") || role.starts_with("ux"));
            let goal_line = goal_ancestry_line(&app, &run_id, &role);
            let system = work_system(&rules, &pname, &title, ships_files, &project_name, &repo_line, &docs_line, &goal_line, &run_id);
            let user = if handoff.is_empty() {
                format!("## Task from the user\n{task}{docs_section}\n\nYou are the first teammate to answer. Deliver your part.")
            } else {
                format!("## Task from the user\n{task}{docs_section}\n\n## What teammates before you already produced\n{handoff}\n\nNow deliver YOUR part ({title}).")
            };
            let cap = if ships_files { 6000 } else { 1400 };
            let (harness, hcmd) = persona_harness(&app, &role);
            let external = harness != "native";
            let result = if external {
                harness_step(&app, &run_id, &role, &harness, &hcmd, model.as_deref().unwrap_or(""), &system, &user).await
            } else {
                match model.as_deref() {
                    Some(m) => llm_step(&app, &run_id, &role, "work", m, &system, &user, cap).await,
                    None => Err(err(StatusCode::BAD_REQUEST, "No model configured for this agent — set one in AI Team")),
                }
            };
            let error_outcome = |msg: String| {
                let mut store = app.store.lock().unwrap();
                if let Some(step) = store.runs.iter_mut().find(|r| r.id == run_id).and_then(|r| r.steps.iter_mut().find(|s| s.role == role && s.kind == "work")) {
                    step.status = "error".into();
                    step.output = msg;
                    step.finished_at = now_secs();
                }
                save_runs(&store);
            };
            match result {
                Ok(Some(output)) if !output.is_empty() => {
                    let mut clean = strip_ask(&output);
                    if external {
                        mark_harness_step(&app, &run_id, &role, &harness);
                    } else {
                        apply_files_note(&app, repo_path.as_deref(), &role, &mut clean).await;
                    }
                    deliver_and_close(&app, &run_id, &role, &clean, None).await;
                }
                Ok(None) => { wind_down_or_pause(&app, &run_id); return; }
                Ok(Some(_)) => error_outcome("Model returned an empty answer".into()),
                Err(e) => error_outcome(e.1),
            }
        }
        // The two tail stages are self-contained: re-running one redoes the
        // real git/LLM work against the current workspace state.
        "pr" => {
            let dev = persona_of(&app, &role);
            let _ = run_pr_stage(&app, &run_id, &role, &repo_url, &task, &project_name, &dev).await;
        }
        "demo" => {
            // Rebuild the PR facts of record from the stored steps, then rerun
            // the scripted demo session against them.
            let (pr, dev_role) = {
                let store = app.store.lock().unwrap();
                let run = match store.runs.iter().find(|r| r.id == run_id) { Some(r) => r, None => return };
                let dev_role = run.steps.iter().find(|s| s.kind == "pr" || (s.kind == "work" && s.role.starts_with("dev")))
                    .map(|s| s.role.clone()).unwrap_or_default();
                let pr_step = run.steps.iter().find(|s| s.kind == "pr");
                let pr = PrOutcome {
                    status: pr_step.map(|s| if s.status == "done" { "done".to_string() } else { s.status.clone() })
                        .unwrap_or_else(|| "skipped".into()),
                    url: pr_step.and_then(|s| extract_pr_url(&s.output)).unwrap_or_default(),
                    branch: run_id.clone(),
                    note: pr_step.filter(|s| s.status != "done").map(|s| one_line(&s.output, 160)).unwrap_or_default(),
                };
                (pr, dev_role)
            };
            if dev_role.is_empty() {
                step_transition(&app, &run_id, "po", "demo", "error", "no dev role found in this run — cannot rerun the acceptance demo").await;
            } else {
                let qa = persona_of(&app, "qa");
                let dev = persona_of(&app, &dev_role);
                let po = persona_of(&app, "po");
                let _ = run_demo_session(&app, &run_id, &task, &project_name, &dev_role, &qa, &dev, &po, &pr).await;
            }
        }
        _ => {}
    }

    // Close the run again — same rule as the relay engine (all-error ⇒ error),
    // and a Stop pressed while the retry was in flight wins.
    let stopped = stop_requested(&app, &run_id);
    let all_error = {
        let store = app.store.lock().unwrap();
        store.runs.iter().find(|r| r.id == run_id)
            .map(|r| r.steps.iter().all(|s| s.status == "error"))
            .unwrap_or(false)
    };
    let final_status = if stopped { "stopped" } else if all_error { "error" } else { "done" };
    finish_run(&app, &run_id, final_status);
}

/// Create a run for the project's current team, store it and start
/// `execute_run` in the background. Shared by the API handler and the loop
/// engine (each loop iteration spawns the next run this way). Returns the
/// stored run — its `.id` is what links a loop chain via `next_run_id`.
fn spawn_run(app: &App, project_id: &str, task: &str, loop_mode: bool, iteration: u32) -> Result<Run, ApiError> {
    spawn_run_with(app, project_id, task, loop_mode, iteration, "manual", None)
}

/// Same as spawn_run, with an explicit trigger (manual / scheduled / loop) and
/// routine provenance. Scheduled runs snapshot the project goal + budget.
fn spawn_run_with(
    app: &App, project_id: &str, task: &str, loop_mode: bool, iteration: u32,
    trigger: &str, routine_id: Option<&str>,
) -> Result<Run, ApiError> {
    let run = {
        let mut store = app.store.lock().unwrap();
        let p = store.projects.iter().find(|p| p.id == project_id)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Project '{project_id}' not found")))?;
        let (project_name, agents) = (p.name.clone(), p.agents.clone());
        let (goal, mut budget_usd) = (p.goal.clone(), p.budget_usd);
        if agents.is_empty() {
            return Err(err(StatusCode::BAD_REQUEST, "Project has no team — add agents on the flow first"));
        }
        // One live mission per project: manual runs (double-click / API), loop
        // children and routines all share one working tree + one tmux session,
        // so concurrent runs would cross-contaminate each other's commits.
        if store.runs.iter().any(|r| r.project_id == project_id
            && (r.status == "running" || r.status == "waiting_human"))
        {
            return Err(err(StatusCode::CONFLICT,
                "A mission is already active on this project — wait for it to finish or stop it first"));
        }
        // A loop child may only spend what the chain has left.
        if iteration > 1 {
            if let Some(parent) = store.runs.iter()
                .filter(|r| r.project_id == project_id)
                .max_by_key(|r| r.iteration)
            {
                if let Some(b) = parent.budget_usd {
                    let remaining = (b - parent.cost_usd).max(0.0);
                    if remaining <= 0.0 {
                        return Err(err(StatusCode::CONFLICT, "loop stopped: project budget exhausted"));
                    }
                    budget_usd = Some(remaining);
                }
            }
        }
        let personas = store.personas.clone();
        let steps = agents.iter()
            .filter_map(|role| personas.iter().find(|p| p.role == *role).map(|p| RunStep {
                role: p.role.clone(), name: p.name.clone(), title: p.title.clone(),
                kind: "work".into(),
                status: "pending".into(), output: String::new(),
                model: None, container: None, deliverable: None, rev: None,
                started_at: 0, finished_at: 0, harness: None,
                input_tokens: 0, output_tokens: 0, cost_usd: 0.0, metered: true, priced: true,
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
            trigger: trigger.into(),
            routine_id: routine_id.map(str::to_string),
            goal,
            budget_usd,
            cost_usd: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            cost_alerted: false,
            review: None,
            watchdog_note: None,
            watchdog_at: 0,
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

#[derive(Deserialize)]
struct RoutineCreate {
    name: String,
    task: String,
    cron: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    loop_mode: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RoutineUpdate {
    name: Option<String>,
    task: Option<String>,
    cron: Option<String>,
    enabled: Option<bool>,
    loop_mode: Option<bool>,
}

/// Next occurrence for a routine, using the same base as the scheduler.
fn routine_next_run(r: &Routine) -> Option<u64> {
    if !r.enabled { return None; }
    next_run_at(&r.cron, if r.last_run_at > 0 { r.last_run_at } else { r.created_at.max(1) })
}

fn routine_json(r: &Routine) -> Value {
    let mut v = serde_json::to_value(r).unwrap_or_else(|_| json!({}));
    v["next_run_at"] = json!(routine_next_run(r));
    v
}

async fn list_routines(State(app): State<App>, headers: axum::http::HeaderMap, Path(project_id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let store = app.store.lock().unwrap();
    if !store.projects.iter().any(|p| p.id == project_id) {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{project_id}' not found")));
    }
    let list: Vec<Value> = store.routines.iter().filter(|r| r.project_id == project_id).map(routine_json).collect();
    Ok(json_ok(json!(list)))
}

async fn create_routine(
    State(app): State<App>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<String>,
    Json(req): Json<RoutineCreate>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let name = req.name.trim().to_string();
    let task = req.task.trim().to_string();
    let cron = req.cron.trim().to_string();
    if name.is_empty() || task.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name and task are required"));
    }
    if cron_parse(&cron).is_none() {
        return Err(err(StatusCode::BAD_REQUEST,
            "invalid cron — use 5 fields (minute hour day-of-month month day-of-week), e.g. '0 9 * * 1-5'"));
    }
    if next_run_at(&cron, now_secs()).is_none() {
        return Err(err(StatusCode::BAD_REQUEST,
            "this cron never fires (e.g. day 31 in February) — check the day-of-month / month combination"));
    }
    let mut store = app.store.lock().unwrap();
    if !store.projects.iter().any(|p| p.id == project_id) {
        return Err(err(StatusCode::NOT_FOUND, format!("Project '{project_id}' not found")));
    }
    store.routine_counter += 1;
    let routine = Routine {
        id: format!("rt-{:03}", store.routine_counter),
        project_id,
        name,
        task,
        cron,
        enabled: req.enabled,
        loop_mode: req.loop_mode,
        last_run_at: 0,
        last_run_id: None,
        last_result: String::new(),
        created_at: now_secs(),
    };
    let out = routine_json(&routine);
    store.routines.push(routine);
    save_routines(&store);
    Ok(json_ok(out))
}

async fn update_routine(
    State(app): State<App>,
    headers: axum::http::HeaderMap,
    Path(rid): Path<String>,
    Json(req): Json<RoutineUpdate>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let routine = store.routines.iter_mut().find(|r| r.id == rid)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Routine '{rid}' not found")))?;
    if let Some(cron) = req.cron.as_deref() {
        let cron = cron.trim();
        if cron_parse(cron).is_none() {
            return Err(err(StatusCode::BAD_REQUEST,
                "invalid cron — use 5 fields (minute hour day-of-month month day-of-week), e.g. '0 9 * * 1-5'"));
        }
        if next_run_at(cron, now_secs()).is_none() {
            return Err(err(StatusCode::BAD_REQUEST,
                "this cron never fires (e.g. day 31 in February) — check the day-of-month / month combination"));
        }
        routine.cron = cron.to_string();
    }
    if let Some(name) = req.name.as_deref() {
        let name = name.trim();
        if name.is_empty() { return Err(err(StatusCode::BAD_REQUEST, "name cannot be empty")); }
        routine.name = name.to_string();
    }
    if let Some(task) = req.task.as_deref() {
        let task = task.trim();
        if task.is_empty() { return Err(err(StatusCode::BAD_REQUEST, "task cannot be empty")); }
        routine.task = task.to_string();
    }
    if let Some(v) = req.enabled { routine.enabled = v; }
    if let Some(v) = req.loop_mode { routine.loop_mode = v; }
    let out = routine_json(routine);
    save_routines(&store);
    Ok(json_ok(out))
}

async fn delete_routine(State(app): State<App>, headers: axum::http::HeaderMap, Path(rid): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let before = store.routines.len();
    store.routines.retain(|r| r.id != rid);
    if store.routines.len() == before {
        return Err(err(StatusCode::NOT_FOUND, format!("Routine '{rid}' not found")));
    }
    save_routines(&store);
    Ok(json_ok(json!({ "ok": true })))
}

async fn run_routine(State(app): State<App>, headers: axum::http::HeaderMap, Path(rid): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let routine = {
        let store = app.store.lock().unwrap();
        store.routines.iter().find(|r| r.id == rid).cloned()
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Routine '{rid}' not found")))?
    };
    let run = fire_routine(&app, &routine)?;
    Ok(json_ok(serde_json::to_value(run).unwrap()))
}

async fn list_runs(State(app): State<App>, headers: axum::http::HeaderMap) -> Result<Json<Vec<Run>>, ApiError> {
    app.require_auth(&headers)?;
    let mut runs = app.store.lock().unwrap().runs.clone();
    runs.reverse();
    Ok(Json(runs))
}

async fn get_run(State(app): State<App>, headers: axum::http::HeaderMap, Path(run_id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
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
    let is_review = disc.kind == "review";
    disc.messages.push(MeetingMessage { from: "human".into(), text: text.clone(), at: now_secs() });
    // Only the live need-human wait reacts to the message; otherwise it is kept as a record.
    if disc.status == "need_human" {
        disc.status = "answering".into();
        disc.answering = None;
        if run.status == "waiting_human" {
            run.status = "running".into();
        }
    }
    // A chat reply on a review discussion may itself carry the decision.
    if is_review {
        apply_review_text(run, &text);
    }
    save_runs(&store);
    Ok(json_ok(json!({ "ok": true })))
}

/// Ask the engine to wind the run down at its next checkpoint (also ends a loop chain).
async fn stop_run(State(app): State<App>, headers: axum::http::HeaderMap, Path(run_id): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let (status, stalled) = match store.runs.iter_mut().find(|r| r.id == run_id) {
        Some(run) => {
            if run.status != "running" && run.status != "waiting_human" {
                return Err(err(StatusCode::BAD_REQUEST, format!("Run is already {}", run.status)));
            }
            run.stop_requested = true;
            (run.status.clone(), run.watchdog_note.is_some())
        }
        None => return Err(err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found"))),
    };
    save_runs(&store);
    drop(store);
    // A waiting run and a watchdog-flagged run have no engine tick coming:
    // close them here, otherwise Stop leaves them "running" forever and the
    // project stays blocked by its one-live-run rule.
    if status == "waiting_human" || stalled {
        finish_run(&app, &run_id, "stopped");
    }
    Ok(json_ok(json!({ "ok": true, "status": status })))
}

#[derive(Deserialize)]
struct ReviewDecision {
    decision: String,
    #[serde(default)]
    comment: String,
}

/// Explicit approve/reject action for the pending pre-push review.
async fn decide_review(
    State(app): State<App>,
    headers: axum::http::HeaderMap,
    Path(run_id): Path<String>,
    Json(req): Json<ReviewDecision>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let decision = req.decision.trim().to_lowercase();
    if decision != "approve" && decision != "reject" {
        return Err(err(StatusCode::BAD_REQUEST, "decision must be 'approve' or 'reject'"));
    }
    let mut store = app.store.lock().unwrap();
    let run = store.runs.iter_mut().find(|r| r.id == run_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found")))?;
    let review = run.review.as_mut()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "this run has no diff review"))?;
    if review.status != "pending" {
        return Err(err(StatusCode::BAD_REQUEST, format!("review is already {}", review.status)));
    }
    let approve = decision == "approve";
    review.status = if approve { "approved".into() } else { "rejected".into() };
    review.comment = req.comment.trim().to_string();
    review.decided_at = now_secs();
    let msg = if approve {
        "APPROVE".to_string()
    } else {
        format!("REJECT: {}", review.comment)
    };
    if let Some(disc) = run.discussions.iter_mut().rev().find(|d| d.kind == "review" && d.status == "need_human") {
        disc.messages.push(MeetingMessage { from: "human".into(), text: msg, at: now_secs() });
        disc.status = "answering".into();
        disc.answering = None;
    }
    if run.status == "waiting_human" {
        run.status = "running".into();
        run.phase = "working".into();
    }
    save_runs(&store);
    Ok(json_ok(json!({ "ok": true, "status": if approve { "approved" } else { "rejected" } })))
}

/// Parse `APPROVE` / `REJECT: <comment>` sent as a chat reply into the review.
fn apply_review_text(run: &mut Run, text: &str) {
    let t = text.trim();
    let upper = t.to_uppercase();
    let (status, comment) = if upper.starts_with("APPROVE") {
        ("approved", String::new())
    } else if upper.starts_with("REJECT") {
        ("rejected", t.chars().skip(6).collect::<String>()
            .trim_start_matches([':', '-', ' ', ':', '：']).trim().to_string())
    } else {
        return;
    };
    if let Some(review) = run.review.as_mut() {
        if review.status == "pending" {
            review.status = status.into();
            review.comment = comment;
            review.decided_at = now_secs();
        }
    }
}

/// Raise the per-run budget after a budget pause. This is the ONLY way to
/// resume a budget-blocked run — a plain chat reply deliberately does not
/// change the limit. Appends a human message so `wait_for_human` resumes.
#[derive(Deserialize)]
struct BudgetUpdate {
    budget_usd: f64,
}

async fn set_run_budget(
    State(app): State<App>,
    headers: axum::http::HeaderMap,
    Path(run_id): Path<String>,
    Json(req): Json<BudgetUpdate>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    let run = store.runs.iter_mut().find(|r| r.id == run_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found")))?;
    if !req.budget_usd.is_finite() || req.budget_usd <= 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "budget_usd must be a positive number"));
    }
    if req.budget_usd <= run.cost_usd {
        return Err(err(StatusCode::BAD_REQUEST, format!(
            "budget ${:.4} must be above the ${:.4} already spent", req.budget_usd, run.cost_usd)));
    }
    run.budget_usd = Some(req.budget_usd);
    run.cost_alerted = false;
    if let Some(disc) = run.discussions.iter_mut().rev().find(|d| d.kind == "budget" && d.status != "resolved") {
        disc.messages.push(MeetingMessage {
            from: "human".into(),
            text: format!("budget raised to ${:.2}", req.budget_usd),
            at: now_secs(),
        });
        disc.status = "answering".into();
        disc.answering = None;
    }
    if run.status == "waiting_human" {
        run.status = "running".into();
        run.phase = "working".into();
    }
    let out = run.clone();
    save_runs(&store);
    Ok(json_ok(json!(out)))
}

/// Per-item retry: re-run ONE failed/skipped/stopped step of a CLOSED run in place.
/// Failures are per-step, so recovery is per-step too — the rest of the mission
/// (every other step's output, the meetings, the tail outcomes) is kept as-is
/// and no new run is created. The step flips to working, the run reopens as
/// running, and `retry_step_engine` closes it again when the step lands.
async fn retry_step(
    State(app): State<App>,
    headers: axum::http::HeaderMap,
    Path((run_id, role, kind)): Path<(String, String, String)>,
) -> ApiResult {
    app.require_auth(&headers)?;
    let mut store = app.store.lock().unwrap();
    {
        let run = store.runs.iter().find(|r| r.id == run_id)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found")))?;
        if run.status == "running" || run.status == "waiting_human" {
            return Err(err(StatusCode::BAD_REQUEST, format!("Run is still {} — wait for it to finish first", run.status)));
        }
        // Reopening this run must not collide with a newer live mission on the
        // same project (same working tree + branch).
        if store.runs.iter().any(|r| r.id != run_id && r.project_id == run.project_id
            && (r.status == "running" || r.status == "waiting_human"))
        {
            return Err(err(StatusCode::CONFLICT,
                "A newer mission is active on this project — wait for it to finish before retrying this step"));
        }
    }
    let run = store.runs.iter_mut().find(|r| r.id == run_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Run '{run_id}' not found")))?;
    let step = run.steps.iter_mut().find(|s| s.role == role && s.kind == kind)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("Step '{role}/{kind}' not found in run '{run_id}'")))?;
    if step.status != "error" && step.status != "skipped" && step.status != "stopped" {
        return Err(err(StatusCode::BAD_REQUEST, format!("Step '{role}/{kind}' is '{}' — only failed, skipped or stopped steps can be retried", step.status)));
    }
    step.status = "working".into();
    step.output = String::new();
    step.started_at = now_secs();
    step.finished_at = 0;
    run.status = "running".into();
    run.phase = "working".into();
    // an old Stop flag must not kill the retry the moment it starts
    run.stop_requested = false;
    let out = run.clone();
    save_runs(&store);
    drop(store);
    let bg = app.clone();
    tokio::spawn(async move { retry_step_engine(bg, run_id, role, kind).await });
    Ok(json_ok(serde_json::to_value(out).unwrap()))
}

/// What one agent is doing right now + everything it has done, across all runs —
/// powers the agent detail dialog on the flow chart. History survives restarts
/// because runs are persisted to /data/runs.json.
async fn agent_activity(State(app): State<App>, headers: axum::http::HeaderMap, Path(role): Path<String>) -> ApiResult {
    app.require_auth(&headers)?;
    let runs = app.store.lock().unwrap().runs.clone();

    // Live state: the newest run that is still in flight (running or paused on a human).
    let mut current: Option<Value> = None;
    for run in runs.iter().filter(|r| r.status == "running" || r.status == "waiting_human") {
        if !run.steps.iter().any(|s| s.role == role) { continue; }
        // a tail stage in flight (pr/demo) is the more specific live step
        let step = run.steps.iter().find(|s| s.role == role && s.status == "working")
            .or_else(|| run.steps.iter().find(|s| s.role == role && s.kind == "work"))
            .or_else(|| run.steps.iter().find(|s| s.role == role))
            .unwrap();
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
        } else if step.status == "working" && step.kind == "pr" {
            ("working".to_string(), "กำลังเปิด Pull Request จริง".to_string(), None)
        } else if step.status == "working" && step.kind == "demo" {
            ("working".to_string(), "กำลัง demo ตรวจรับหน้างานกับ PO".to_string(), None)
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

    // History: EVERY step this agent owns in every run (work + pr/demo), newest first.
    let mut history: Vec<Value> = runs.iter()
        .filter(|r| r.steps.iter().any(|s| s.role == role))
        .flat_map(|r| {
            let meetings = r.discussions.iter()
                .filter(|d| d.from == role || d.to.iter().any(|t| t == &role) || d.messages.iter().any(|m| m.from == role))
                .count();
            r.steps.iter().filter(|s| s.role == role).map(move |s| {
                let excerpt: String = s.output.chars().take(300).collect();
                json!({
                    "run_id": r.id,
                    "project_id": r.project_id,
                    "project_name": r.project_name,
                    "task": r.task,
                    "run_status": r.status,
                    "kind": s.kind,
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
            }).collect::<Vec<_>>()
        })
        .collect();
    history.reverse();
    history.truncate(50);

    Ok(json_ok(json!({ "role": role, "current": current, "history": history })))
}

// ---------------------------------------------------------------------------
// Admin auth — one password gates console access to all containers
// ---------------------------------------------------------------------------

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 32 random bytes from the OS → 64 hex chars. Falls back to hashing a few
/// process/high-resolution values only if /dev/urandom is unreadable.
fn random_hex(bytes: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_ok();
    if !ok {
        let seed = format!("{:?}:{}:{}", std::time::SystemTime::now(), std::process::id(), bytes);
        let mut out = String::new();
        while out.len() < bytes * 2 {
            out.push_str(&sha256_hex(&format!("{seed}:{}", out.len())));
        }
        return out.chars().take(bytes * 2).collect();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

async fn verify_admin(State(app): State<App>, Json(req): Json<AuthVerify>) -> Json<Value> {
    let hash = app.store.lock().unwrap().config.admin_password_hash.clone();
    let attempt = sha256_hex(&req.password);
    Json(json!({ "ok": !hash.is_empty() && constant_time_eq(attempt.as_bytes(), hash.as_bytes()) }))
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
    let user_ok = constant_time_eq(req.username.as_bytes(), user.as_bytes());
    let pass_ok = constant_time_eq(req.password.as_bytes(), pass.as_bytes());
    if !(user_ok & pass_ok) {
        return Err(err(StatusCode::UNAUTHORIZED, "Invalid username or password"));
    }
    let token = random_hex(32);
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

/// Roles the run engine may exec into at any moment — the idle sweeper never
/// pauses these. waiting_human runs are NOT busy: while waiting, the engine
/// only polls the store, and `agent_container` revives a paused agent the
/// moment the human replies and the run flips back to running.
fn busy_roles(store: &Store) -> std::collections::HashSet<String> {
    store.runs.iter()
        .filter(|r| r.status == "running")
        .flat_map(|r| r.steps.iter().map(|s| s.role.clone()))
        .collect()
}

/// Background loop: every IDLE_SWEEP_INTERVAL_SECS, kill the tmux sessions of
/// agents that have been idle longer than config.idle_timeout_secs and are
/// not needed by any live run. An idle shell costs nothing, but the sweep
/// still kills stray long-running processes left in an agent's windows and
/// keeps the paused/running state machine (and the UI) meaningful. Pausing =
/// kill session + registry entry. A kill that races an incoming activity is
/// benign by design: the next `agent_container` / `ensure_running` call
/// recreates the session instantly.
async fn idle_sweeper(app: App) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(IDLE_SWEEP_INTERVAL_SECS));
    loop {
        tick.tick().await;
        let (enabled, idle_after) = {
            let store = app.store.lock().unwrap();
            (store.config.auto_pause_enabled, store.config.idle_timeout_secs)
        };
        if !enabled || idle_after == 0 { continue; }

        let busy = {
            let store = app.store.lock().unwrap();
            busy_roles(&store)
        };

        let sessions: Vec<String> = hostexec::list_sessions().await
            .into_iter().filter(|s| s.starts_with("agent-")).collect();

        // Reconcile: a registry entry whose session is alive again (someone
        // raced the sweeper with a start/resume) is stale — drop it.
        {
            let mut store = app.store.lock().unwrap();
            let mut changed = false;
            for name in &sessions {
                if store.paused.remove(name).is_some() { changed = true; }
            }
            if changed { save_paused(&store); }
        }

        let now = now_secs();
        for name in sessions {
            let role = hostexec::role_of(&name).to_string();
            if busy.contains(&role) { continue; }
            // First sighting starts the clock (persisted into the store, not
            // just the snapshot) — a fresh session gets one full idle window
            // before it is a candidate.
            let last = {
                let mut store = app.store.lock().unwrap();
                *store.last_activity.entry(name.clone()).or_insert(now)
            };
            if now.saturating_sub(last) < idle_after { continue; }
            if hostexec::kill_session(&name).await {
                app.mark_paused(&name, true);
                println!("auto-paused idle agent '{name}' (idle {}s, role '{role}')", now - last);
            }
        }
    }
}

/// Advisory run watchdog (Paperclip-style heartbeat check, without the kill):
/// a `running` run that has produced no step/discussion activity for a long
/// time is probably wedged — a hung provider call, a lost goroutine, a machine
/// asleep. We do NOT change its status (that would fight the engine's own
/// state machine); we flag it so the UI can tell the user to look or stop it.
/// The flag clears itself as soon as fresh activity lands.
fn watchdog_stall_secs() -> u64 {
    std::env::var("AAP_WATCHDOG_STALL_SECS").ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v >= 60)
        .unwrap_or(45 * 60)
}

/// Newest timestamp anywhere in a run — step start/finish, chat message,
/// discussion open, or run creation. The watchdog treats this as the run's
/// heartbeat; anything newer means the engine is still moving.
fn run_last_heartbeat(run: &Run) -> u64 {
    let mut last = run.created_at;
    for s in &run.steps { last = last.max(s.started_at).max(s.finished_at); }
    for d in &run.discussions {
        last = last.max(d.created_at);
        for m in &d.messages { last = last.max(m.at); }
    }
    last
}

async fn run_watchdog(app: App) {
    let stall = watchdog_stall_secs();
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        tick.tick().await;
        let now = now_secs();
        let mut changed = false;
        {
            let mut store = app.store.lock().unwrap();
            for run in store.runs.iter_mut() {
                let last = run_last_heartbeat(run);
                if run.status != "running" {
                    // Closed runs keep no warning; a reopened one starts clean.
                    if run.watchdog_note.is_some() || run.watchdog_at != 0 {
                        run.watchdog_note = None;
                        run.watchdog_at = 0;
                        changed = true;
                    }
                    continue;
                }
                let idle = now.saturating_sub(last);
                if idle >= stall && run.watchdog_at < last.max(1) {
                    let working: Vec<&str> = run.steps.iter()
                        .filter(|s| s.status == "working")
                        .map(|s| s.name.as_str())
                        .collect();
                    let who = if working.is_empty() { "ทั้งทีม".to_string() } else { working.join(", ") };
                    run.watchdog_note = Some(format!(
                        "ไม่มีความคืบหน้ามา {} นาที — {} อาจค้างอยู่ (provider ไม่ตอบ / เครื่อง sleep / process หาย) \
                         ตรวจสอบ terminal ของ agent หรือกดหยุด run แล้วลองใหม่",
                        idle / 60, who,
                    ));
                    run.watchdog_at = now;
                    changed = true;
                } else if run.watchdog_at != 0 && last > run.watchdog_at {
                    // heartbeats are flowing again — withdraw the warning
                    run.watchdog_note = None;
                    run.watchdog_at = 0;
                    changed = true;
                }
            }
            if changed { save_runs(&store); }
        }
    }
}

#[tokio::main]
async fn main() {
    // Agents run on THIS machine — no Docker client, no per-agent containers,
    // no container-based deploy stage. Docker plays no part in the platform.
    let _ = hostexec::tmux_available(); // warn early when tmux is missing
    hostexec::sweep_tmp(); // command files from a previous process are garbage
    harden_data_dir(); // 0700 data dir / 0600 stores, even after an upgrade
    let ws = hostexec::workspace_dir();
    if let Err(e) = std::fs::create_dir_all(&ws) {
        eprintln!("warning: workspace {} unusable: {e} — set AAP_WORKSPACE", ws.display());
    }

    let app_state = App {
        store: {
            let mut store = Store::default();
            load_personas(&mut store); // personas survive restarts (personas.json)
            load_config(&mut store);   // provider config + pricing (config.json, 0600)
            load_skills(&mut store);   // skills + test bench (skills.json)
            load_tasks(&mut store);    // board tasks (tasks.json)
            load_projects(&mut store); // projects survive restarts (projects.json) — BEFORE load_runs, whose counter salvage scans store.projects
            load_runs(&mut store); // work history survives restarts (runs.json)
            load_docs(&mut store); // document space + comments survive restarts (docs.json)
            load_routines(&mut store); // scheduled routines (routines.json)
            load_paused(&mut store); // paused-registry survives restarts (paused.json)
            load_agents(&mut store); // agent registry survives restarts (agents.json)
            // tmux sessions outlive this process — adopt any live ones
            for s in hostexec::list_sessions().await {
                if s.starts_with("agent-") && store.agents.insert(s) {
                    save_agents(&store);
                }
            }
            Arc::new(Mutex::new(store))
        },
        seq: Arc::new(AtomicUsize::new(1)),
    };

    println!("host execution — workspace {} (AAP_WORKSPACE overrides)", ws.display());

    // Idle sweeper — auto-pause agents idle past the configured window.
    tokio::spawn(idle_sweeper(app_state.clone()));
    // Routine scheduler — fires enabled cron schedules every 30 s.
    tokio::spawn(routine_scheduler(app_state.clone()));
    // Run watchdog — flags runs that stopped producing any heartbeat.
    tokio::spawn(run_watchdog(app_state.clone()));

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
        .route("/agents/harnesses", get(list_harnesses))
        .route("/agents/{role}", put(update_persona).delete(delete_persona))
        .route("/agents/{role}/start", post(start_agent))
        .route("/agents/{role}/activity", get(agent_activity))
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{task_id}", delete(delete_task))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{id}", get(get_project).put(update_project).delete(delete_project))
        .route("/projects/{id}/docs", get(list_docs).post(create_doc))
        .route("/projects/{id}/docs/upload",
               post(upload_doc).layer(axum::extract::DefaultBodyLimit::max(DOC_UPLOAD_MAX_BYTES + 65536)))
        .route("/projects/{id}/docs/{doc_id}", get(get_doc).put(update_doc).delete(delete_doc))
        .route("/projects/{id}/docs/{doc_id}/comments",
               get(list_doc_comments).post(create_doc_comment))
        .route("/projects/{id}/docs/{doc_id}/comments/{comment_id}",
               put(update_doc_comment).delete(delete_doc_comment))
        .route("/projects/{id}/run", post(run_project))
        .route("/projects/{id}/routines", get(list_routines).post(create_routine))
        .route("/routines/{rid}", put(update_routine).delete(delete_routine))
        .route("/routines/{rid}/run", post(run_routine))
        .route("/runs", get(list_runs))
        .route("/runs/{run_id}", get(get_run))
        .route("/runs/{run_id}/stop", post(stop_run))
        .route("/runs/{run_id}/budget", post(set_run_budget))
        .route("/runs/{run_id}/review", post(decide_review))
        .route("/runs/{run_id}/steps/{role}/{kind}/retry", post(retry_step))
        .route("/runs/{run_id}/discussions/{disc_id}/reply", post(reply_discussion))
        .route("/config", get(get_config).put(update_config))
        .route("/skills", get(list_skills).post(create_skill))
        .route("/skills/{skill_id}", put(update_skill).delete(delete_skill))
        .route("/skills/{skill_id}/tests", put(set_skill_tests))
        .route("/skills/{skill_id}/tests/run", post(run_skill_tests))
        .route("/skills/{skill_id}/restore/{version}", post(restore_skill))
        .fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({ "detail": "Not Found" }))) })
        .layer(cors)
        .with_state(app_state);

    // Loopback unless auth is on (or the operator explicitly widens the bind):
    // every endpoint controls real processes on this Mac, so a LAN-reachable
    // server with login disabled would hand anyone the host.
    let bind = std::env::var("AAP_BIND").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| {
        if auth_enabled() { "0.0.0.0:8000".into() } else { "127.0.0.1:8000".into() }
    });
    if !auth_enabled() {
        println!("auth disabled (no ADMIN_PASSWORD) — listening on {bind}; set AAP_BIND to expose it");
    }
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    println!("{SERVICE_NAME} listening on {bind}");
    axum::serve(listener, router).await.expect("server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> u64 {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).unwrap().timestamp() as u64
    }

    fn test_run(status: &str) -> Run {
        Run {
            id: "r-test".into(),
            project_id: "p-test".into(),
            project_name: "Test".into(),
            task: "task".into(),
            status: status.into(),
            steps: Vec::new(),
            phase: "work".into(),
            round: 1,
            discussions: Vec::new(),
            summary: None,
            acceptance: None,
            created_at: 1,
            loop_mode: false,
            iteration: 1,
            stop_requested: false,
            next_run_id: None,
            trigger: "manual".into(),
            routine_id: None,
            goal: String::new(),
            budget_usd: None,
            cost_usd: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            cost_alerted: false,
            review: None,
            watchdog_note: None,
            watchdog_at: 0,
        }
    }

    #[test]
    fn watchdog_heartbeat_uses_newest_signal() {
        let mut run = test_run("running");
        run.created_at = 100;
        run.steps.push(RunStep {
            role: "dev".into(), name: "Dev".into(), title: "Dev".into(), kind: "work".into(),
            status: "working".into(), output: String::new(), model: None, container: None,
            deliverable: None, rev: None, started_at: 200, finished_at: 0, harness: None,
            input_tokens: 0, output_tokens: 0, cost_usd: 0.0, metered: true, priced: true,
        });
        run.discussions.push(Discussion {
            id: "d-001".into(), kind: String::new(), from: "dev".into(), to: vec!["qa".into()],
            topic: "?".into(), status: "open".into(), answering: None,
            messages: vec![MeetingMessage { from: "qa".into(), text: "answer".into(), at: 300 }],
            round: 1, created_at: 150,
        });
        assert_eq!(run_last_heartbeat(&run), 300);
        // A closed run's creation time is the floor, never 0.
        let empty = test_run("done");
        assert_eq!(run_last_heartbeat(&empty), empty.created_at);
    }

    #[test]
    fn cron_field_parsing() {
        assert_eq!(parse_cron_field("*", 0, 5), Some(vec![0, 1, 2, 3, 4, 5]));
        assert_eq!(parse_cron_field("1,15", 0, 59), Some(vec![1, 15]));
        assert_eq!(parse_cron_field("9-11", 0, 23), Some(vec![9, 10, 11]));
        assert_eq!(parse_cron_field("*/20", 0, 59), Some(vec![0, 20, 40]));
        assert_eq!(parse_cron_field("10-20/5", 0, 59), Some(vec![10, 15, 20]));
        // out of range / malformed
        assert_eq!(parse_cron_field("60", 0, 59), None);
        assert_eq!(parse_cron_field("5-1", 0, 59), None);
        assert_eq!(parse_cron_field("*/0", 0, 59), None);
        assert_eq!(parse_cron_field("x", 0, 59), None);
    }

    #[test]
    fn cron_expression_needs_five_fields() {
        assert!(cron_parse("0 9 * * 1-5").is_some());
        assert!(cron_parse("0 9 * *").is_none());
        assert!(cron_parse("0 9 * * *  *").is_none());
        // dow 7 is normalized to Sunday = 0
        let spec = cron_parse("0 0 * * 7").unwrap();
        assert_eq!(spec.dows, vec![0]);
    }

    #[test]
    fn next_run_is_strictly_after_now() {
        // Monday 2026-01-05 08:30 local → weekdays 09:00 is the same day.
        let after = at(2026, 1, 5, 8, 30);
        assert_eq!(next_run_at("0 9 * * 1-5", after), Some(at(2026, 1, 5, 9, 0)));
        // Exactly on the occurrence → the NEXT one, not now.
        let nine = at(2026, 1, 5, 9, 0);
        assert_eq!(next_run_at("0 9 * * *", nine), Some(at(2026, 1, 6, 9, 0)));
        // Saturday → Monday for a weekdays-only routine.
        let sat = at(2026, 1, 10, 12, 0);
        assert_eq!(next_run_at("0 9 * * 1-5", sat), Some(at(2026, 1, 12, 9, 0)));
    }

    #[test]
    fn usage_cost_prices_per_million_tokens() {
        let usage = LlmUsage { input_tokens: 1_000_000, output_tokens: 500_000 };
        assert!((usage_cost(usage, 3.0, 15.0) - 10.5).abs() < 1e-9);
        assert_eq!(usage_cost(LlmUsage { input_tokens: 0, output_tokens: 0 }, 3.0, 15.0), 0.0);
    }

    #[test]
    fn harness_templates_and_binary_validation() {
        let claude = harness_template("claude", "").unwrap();
        assert!(claude.contains("{prompt_file}"));
        assert_eq!(harness_binary(&claude), "claude");
        // a custom template always wins
        let custom = harness_template("custom", "aider --file {prompt_file}").unwrap();
        assert_eq!(harness_binary(&custom), "aider");
        assert!(harness_template("nope", "").is_none());
        assert!(valid_binary_name("claude"));
        assert!(!valid_binary_name("claude; rm -rf /"));
        assert!(!valid_binary_name(""));
    }

    #[test]
    fn review_text_approve_and_reject() {
        let mut run = test_run("waiting_human");
        run.review = Some(RunReview {
            status: "pending".into(), diff: String::new(), files: Vec::new(),
            comment: String::new(), requested_at: 1, decided_at: 0,
        });
        apply_review_text(&mut run, "APPROVE");
        assert_eq!(run.review.as_ref().unwrap().status, "approved");

        run.review.as_mut().unwrap().status = "pending".into();
        apply_review_text(&mut run, "REJECT: missing empty state");
        let rv = run.review.as_ref().unwrap();
        assert_eq!(rv.status, "rejected");
        assert_eq!(rv.comment, "missing empty state");

        // a normal chat line is not a decision
        run.review.as_mut().unwrap().status = "pending".into();
        apply_review_text(&mut run, "looks fine to me");
        assert_eq!(run.review.as_ref().unwrap().status, "pending");
    }
}
