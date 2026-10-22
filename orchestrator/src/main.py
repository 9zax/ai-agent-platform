from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import docker
import itertools
import json
import os
import urllib.request

ZAI_BASE_URL = os.environ.get("ZAI_BASE_URL", "https://api.z.ai/api/anthropic")
ZAI_API_KEY = os.environ.get("ZAI_API_KEY", "")

# AI team — senior personas (14+ years each) that run inside managed containers
AGENT_PERSONAS = {
    "po": {
        "name": "Nara", "title": "Product Owner",
        "years": "16", "expertise": "Product strategy, user stories, backlog grooming, roadmap, prioritization (RICE/MoSCoW), stakeholder alignment",
        "base": "You are Nara, a Product Owner with 16 years of experience shipping B2B and B2C products. You write crisp, testable user stories with clear acceptance criteria, think in outcomes not features, and ruthlessly prioritize scope.",
    },
    "research": {
        "name": "Kanta", "title": "Research Engineer",
        "years": "15", "expertise": "Technical research, benchmarking, data collection, literature review, proof-of-concept prototyping",
        "base": "You are Kanta, a Research Engineer with 15 years of experience. You validate assumptions with evidence, benchmark alternatives, cite concrete trade-offs, and prototype to de-risk decisions.",
    },
    "dev-fe": {
        "name": "Firn", "title": "Frontend Developer",
        "years": "15", "expertise": "React, Next.js, TypeScript, Tailwind, design systems, accessibility, web performance, Core Web Vitals",
        "base": "You are Firn, a Frontend Developer with 15 years of experience. You write clean, accessible, performant React; you know when to reach for a design system, how to keep bundles small, and you never ship layout that breaks on mobile.",
    },
    "dev-be": {
        "name": "Boyd", "title": "Backend Developer",
        "years": "17", "expertise": "Python, FastAPI, Node.js, PostgreSQL, Redis, API design, distributed systems, observability",
        "base": "You are Boyd, a Backend Developer with 17 years of experience. You design APIs that age well, defend with tests and observability, and you know the difference between 'works' and 'works at 3am under load'.",
    },
    "ux-ui": {
        "name": "Mali", "title": "UX/UI Designer",
        "years": "14", "expertise": "User research, information architecture, interaction design, prototyping, Figma, design tokens, dark-mode systems",
        "base": "You are Mali, a UX/UI Designer with 14 years of experience. You design with evidence from users, keep interfaces calm and consistent, obsess over states (empty/loading/error), and document decisions in tokens and components.",
    },
    "qa": {
        "name": "Tara", "title": "QA Engineer",
        "years": "14", "expertise": "Test strategy, E2E automation (Playwright), API testing, contract testing, CI quality gates, exploratory testing",
        "base": "You are Tara, a QA Engineer with 14 years of experience. You think in risk, write tests that fail for the right reason, automate the boring 80%, and explore the dangerous 20% humans find.",
    },
}

app = FastAPI(title="AI Agent Platform Orchestrator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    docker_client = docker.from_env()
except Exception as e:
    docker_client = None
    print(f"Docker client init failed: {e}")

class ContainerCreate(BaseModel):
    name: str
    role: str
    image: str = "alpine:latest"
    command: Optional[List[str]] = None

class CommandRequest(BaseModel):
    command: str
    consult: bool = False  # True = ask the persona for advice, do NOT execute anything

class AgentStartRequest(BaseModel):
    name: Optional[str] = None

class TaskCreate(BaseModel):
    title: str
    description: str = ""
    status: str = "todo"
    category: str = "General"
    priority: str = "medium"
    agent: str = "AD"
    due: str = ""
    assign_to: Optional[str] = None

_task_ids = itertools.count(1)

CONFIG = {
    "default_model": "glm-4.5-air",
    "default_image": "alpine:latest",
    "max_containers": 10,
    "auto_restart": True,
}

SKILLS = [
    {"id": "web-research", "name": "Web Research", "description": "Search, crawl and summarize web sources", "enabled": True},
    {"id": "code-gen", "name": "Code Gen", "description": "Generate and refactor code from natural language", "enabled": True},
    {"id": "data-analysis", "name": "Data Analysis", "description": "Analyze datasets and produce reports and charts", "enabled": True},
    {"id": "file-ops", "name": "File Ops", "description": "Read, write and organize files in the workspace", "enabled": True},
    {"id": "api-testing", "name": "API Testing", "description": "Call APIs and validate responses against schemas", "enabled": True},
    {"id": "image-analysis", "name": "Image Analysis", "description": "Inspect and describe images", "enabled": False},
]

TASKS = []

@app.get("/")
def root():
    return {"status": "ok", "service": "AI Agent Platform Orchestrator"}

@app.get("/health")
def health():
    return {"status": "healthy", "docker": docker_client is not None}

@app.get("/containers")
def list_containers():
    if not docker_client:
        raise HTTPException(status_code=500, detail="Docker not available")
    containers = docker_client.containers.list(all=True)
    return [{
        "id": c.short_id,
        "name": c.name,
        "status": c.status,
        "image": c.image.tags[0] if c.image.tags else "unknown",
        "labels": c.labels
    } for c in containers]

@app.post("/containers")
def create_container(req: ContainerCreate):
    if not docker_client:
        raise HTTPException(status_code=500, detail="Docker not available")
    try:
        run_kwargs = dict(
            name=req.name,
            detach=True,
            labels={"role": req.role, "managed-by": "ai-agent-platform"},
            network="ai-agent-platform_agent-net",
            environment={"ROLE": req.role},
        )
        if req.command:
            run_kwargs["command"] = req.command
        elif req.image.startswith("alpine"):
            run_kwargs["command"] = ["sh", "-c", "sleep infinity"]
        container = docker_client.containers.run(req.image, **run_kwargs)
        container.reload()
        return {"id": container.short_id, "name": container.name, "status": container.status}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

def _get_container(ident: str):
    if not docker_client:
        raise HTTPException(status_code=500, detail="Docker not available")
    try:
        return docker_client.containers.get(ident)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Container '{ident}' not found")

def _get_managed_container(ident: str):
    container = _get_container(ident)
    if container.labels.get("managed-by") != "ai-agent-platform":
        raise HTTPException(
            status_code=403,
            detail=f"Container '{container.name}' is not managed by this platform",
        )
    return container

def _action(ident: str, action: str):
    container = _get_managed_container(ident)
    try:
        getattr(container, action)()
        container.reload()
        return {"id": container.short_id, "name": container.name, "status": container.status}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/containers/{ident}/start")
def start_container(ident: str):
    return _action(ident, "start")

@app.post("/containers/{ident}/stop")
def stop_container(ident: str):
    return _action(ident, "stop")

@app.post("/containers/{ident}/restart")
def restart_container(ident: str):
    return _action(ident, "restart")

@app.delete("/containers/{ident}")
def delete_container(ident: str):
    container = _get_managed_container(ident)
    try:
        container.remove(force=True)
        return {"id": ident, "status": "deleted"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/containers/{ident}/exec")
def exec_command(ident: str, req: CommandRequest):
    container = _get_managed_container(ident)
    if container.status != "running":
        raise HTTPException(status_code=400, detail=f"Container is not running (status: {container.status})")
    try:
        result = container.exec_run(["sh", "-c", req.command])
        output = result.output.decode(errors="replace") if result.output else ""
        return {"exit_code": result.exit_code, "output": output}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

def _zai_messages(model: str, system: str, user_text: str):
    body = {
        "model": model,
        "max_tokens": 400,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
    }
    req = urllib.request.Request(
        f"{ZAI_BASE_URL}/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": ZAI_API_KEY,
            "authorization": f"Bearer {ZAI_API_KEY}",
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read())
    return "".join(part.get("text", "") for part in data.get("content", []) if part.get("type") == "text").strip()

@app.get("/agent/status")
def agent_status():
    return {"model": CONFIG.get("default_model"), "provider": "ZAI GLM", "key_configured": bool(ZAI_API_KEY)}

@app.get("/agents")
def list_agents():
    """Team roster with live container status per role."""
    running = {}
    if docker_client:
        for c in docker_client.containers.list(all=True):
            role = c.labels.get("role", "")
            if c.labels.get("managed-by") == "ai-agent-platform" and role in AGENT_PERSONAS:
                running[role] = {"name": c.name, "status": c.status, "id": c.short_id}
    return [{
        "role": role,
        "name": p["name"],
        "title": p["title"],
        "years": p["years"],
        "expertise": p["expertise"],
        "container": running.get(role),
    } for role, p in AGENT_PERSONAS.items()]

@app.post("/agents/{role}/start")
def start_agent(role: str, req: AgentStartRequest):
    if role not in AGENT_PERSONAS:
        raise HTTPException(status_code=404, detail=f"Unknown role '{role}'. Available: {', '.join(AGENT_PERSONAS)}")
    if not docker_client:
        raise HTTPException(status_code=500, detail="Docker not available")
    name = req.name or f"agent-{role}"
    try:
        image = CONFIG.get("default_image", "alpine:latest")
        run_kwargs = dict(
            name=name, detach=True,
            labels={"role": role, "managed-by": "ai-agent-platform"},
            network="ai-agent-platform_agent-net",
            environment={"ROLE": role},
        )
        if image.startswith("alpine"):
            run_kwargs["command"] = ["sh", "-c", "sleep infinity"]
        container = docker_client.containers.run(image, **run_kwargs)
        container.reload()
        return {"id": container.short_id, "name": container.name, "role": role, "status": container.status}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

def _persona_for(container):
    role = container.labels.get("role", "")
    persona = AGENT_PERSONAS.get(role)
    if persona:
        return role, persona
    return role, {"name": "Agent", "title": "AI Agent", "base": "You are a capable autonomous Linux agent."}

@app.post("/containers/{ident}/agent")
def agent_command(ident: str, req: CommandRequest):
    """Talk to the container's persona. consult=True → advice only; otherwise the model picks ONE shell command and we run it."""
    container = _get_managed_container(ident)
    if container.status != "running":
        raise HTTPException(status_code=400, detail=f"Container is not running (status: {container.status})")
    if not ZAI_API_KEY:
        raise HTTPException(status_code=503, detail="ZAI_API_KEY is not configured on the orchestrator")

    role, persona = _persona_for(container)
    model = CONFIG.get("default_model") or "glm-4.5-air"

    if req.consult:
        system = (
            f"{persona['base']} "
            "Answer the user in the user's language. Be concise, concrete and senior — like a 14+ year veteran giving advice to a colleague. "
            "Use short markdown lists where helpful. Do NOT invent facts."
        )
        try:
            reply = _zai_messages(model, system, req.command)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ZAI request failed: {e}")
        return {"mode": "consult", "role": role, "model": model, "reply": reply}

    system = (
        f"{persona['base']} "
        "You are operating inside a Linux container (Ubuntu/Alpine, sh shell) as an autonomous agent. "
        "The user gives a request in any language. Answer with EXACTLY ONE line containing ONE safe sh command "
        "that accomplishes the request using your expertise. Output the bare command only — no markdown, no backticks, no explanation. "
        "If the request is a question, answer it with a command that prints the answer (e.g. echo)."
    )
    try:
        reply = _zai_messages(model, system, req.command)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ZAI request failed: {e}")

    command = reply.strip().strip("`").splitlines()[-1].strip() if reply.strip() else ""
    if not command:
        raise HTTPException(status_code=502, detail=f"Model returned no usable command: {reply!r}")

    try:
        result = container.exec_run(["sh", "-c", command])
        output = result.output.decode(errors="replace") if result.output else ""
        return {"mode": "execute", "role": role, "model": model, "reply": reply, "command": command, "exit_code": result.exit_code, "output": output}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/containers/{ident}/stats")
def container_stats(ident: str):
    container = _get_container(ident)
    try:
        s = container.stats(stream=False)
        cpu_delta = s["cpu_stats"]["cpu_usage"]["total_usage"] - s["precpu_stats"]["cpu_usage"]["total_usage"]
        sys_delta = s["cpu_stats"]["system_cpu_usage"] - s["precpu_stats"]["system_cpu_usage"]
        online_cpus = s["cpu_stats"].get("online_cpus") or len(s["cpu_stats"]["cpu_usage"].get("percpu_usage") or [1])
        cpu_percent = round((cpu_delta / sys_delta) * online_cpus * 100, 2) if sys_delta > 0 else 0.0
        mem = s["memory_stats"]
        networks = s.get("networks", {})
        return {
            "cpu_percent": cpu_percent,
            "mem_used": mem.get("usage", 0),
            "mem_limit": mem.get("limit", 0),
            "net_rx": sum(n.get("rx_bytes", 0) for n in networks.values()),
            "net_tx": sum(n.get("tx_bytes", 0) for n in networks.values()),
            "status": container.status,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/containers/{ident}/inspect")
def container_inspect(ident: str):
    container = _get_container(ident)
    try:
        c = container.attrs
        networks = [
            {"name": name, "ip": list((addr.get("IPAMConfig") or {}).values()) or [addr.get("IPAddress")], "aliases": addr.get("Aliases") or []}
            for name, addr in c["NetworkSettings"]["Networks"].items()
        ]
        return {
            "id": c["Id"][:12],
            "name": c["Name"].lstrip("/"),
            "image": c["Config"]["Image"],
            "created": c["Created"],
            "state": c["State"]["Status"],
            "started_at": c["State"].get("StartedAt"),
            "restart_policy": c["HostConfig"].get("RestartPolicy", {}).get("Name", "no"),
            "labels": c["Config"]["Labels"],
            "networks": networks,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/containers/{ident}/files")
def container_files(ident: str, path: str = "/workspace"):
    container = _get_container(ident)
    if container.status != "running":
        raise HTTPException(status_code=400, detail=f"Container is not running (status: {container.status})")
    try:
        result = container.exec_run(["sh", "-c", f"ls -la {path} 2>&1 || ls -la /"])
        return {"path": path, "output": result.output.decode(errors="replace")}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/config")
def get_config():
    return CONFIG

class ConfigUpdate(BaseModel):
    default_model: Optional[str] = None
    default_image: Optional[str] = None
    max_containers: Optional[int] = None
    auto_restart: Optional[bool] = None

@app.put("/config")
def update_config(req: ConfigUpdate):
    for key, value in req.dict().items():
        if value is not None:
            CONFIG[key] = value
    return CONFIG

@app.get("/skills")
def list_skills():
    return SKILLS

class SkillUpdate(BaseModel):
    enabled: bool

@app.put("/skills/{skill_id}")
def update_skill(skill_id: str, req: SkillUpdate):
    for skill in SKILLS:
        if skill["id"] == skill_id:
            skill["enabled"] = req.enabled
            return skill
    raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

@app.get("/tasks")
def list_tasks():
    return TASKS

@app.post("/tasks")
def create_task(task: TaskCreate):
    new_task = {
        "id": f"t-{next(_task_ids):03d}",
        "title": task.title,
        "description": task.description,
        "status": task.status if task.status in ("todo", "in_progress", "done") else "todo",
        "category": task.category,
        "priority": task.priority,
        "agent": task.assign_to or task.agent,
        "due": task.due,
    }
    TASKS.append(new_task)
    return new_task

@app.delete("/tasks/{task_id}")
def delete_task(task_id: str):
    for i, t in enumerate(TASKS):
        if t["id"] == task_id:
            return TASKS.pop(i)
    raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
