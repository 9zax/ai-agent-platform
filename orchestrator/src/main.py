from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import docker

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
    image: str = "ai-agent-platform-agent-base"

class TaskCreate(BaseModel):
    title: str
    description: str
    assign_to: Optional[str] = None

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
        container = docker_client.containers.run(
            req.image,
            name=req.name,
            detach=True,
            labels={"role": req.role, "managed-by": "ai-agent-platform"},
            network="ai-agent-platform_agent-net",
            environment={"ROLE": req.role}
        )
        return {"id": container.short_id, "name": container.name, "status": "created"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/tasks")
def create_task(task: TaskCreate):
    return {
        "id": "task-001",
        "title": task.title,
        "status": "queued",
        "assigned_to": task.assign_to
    }

@app.get("/tasks")
def list_tasks():
    return [
        {"id": "task-001", "title": "Example task", "status": "in_progress", "assigned_to": "backend-01"}
    ]
