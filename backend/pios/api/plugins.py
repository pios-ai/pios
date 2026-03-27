"""Plugin API routes."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class PluginInfo(BaseModel):
    """Plugin information."""

    name: str
    version: str
    type: str
    description: str
    enabled: bool
    last_run: Optional[str] = None


class PluginRunRequest(BaseModel):
    """Request to run a plugin."""

    plugin_name: str


class PluginRunResponse(BaseModel):
    """Plugin run response."""

    run_id: str
    plugin_name: str
    status: str
    started_at: str


@router.get("/", response_model=List[PluginInfo])
async def list_plugins(plugin_manager):
    """List all discovered plugins."""
    plugins = plugin_manager.get_all_plugins()
    return [
        PluginInfo(
            name=p.name,
            version=p.version,
            type=p.type,
            description=plugin_manager.manifests[p.name].description,
            enabled=p.enabled,
            last_run=p.last_run,
        )
        for p in plugins
    ]


@router.get("/{plugin_name}", response_model=PluginInfo)
async def get_plugin(plugin_name: str, plugin_manager):
    """Get plugin information."""
    status = plugin_manager.get_plugin_status(plugin_name)
    if not status:
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")

    manifest = plugin_manager.manifests.get(plugin_name)
    return PluginInfo(
        name=status.name,
        version=status.version,
        type=status.type,
        description=manifest.description if manifest else "",
        enabled=status.enabled,
        last_run=status.last_run,
    )


@router.post("/{plugin_name}/run", response_model=PluginRunResponse)
async def run_plugin(
    plugin_name: str,
    background_tasks: BackgroundTasks,
    plugin_manager,
):
    """Trigger a plugin run."""
    if plugin_name not in plugin_manager.manifests:
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")

    # Run in background
    import uuid
    run_id = str(uuid.uuid4())

    background_tasks.add_task(plugin_manager.run_plugin, plugin_name)

    return PluginRunResponse(
        run_id=run_id,
        plugin_name=plugin_name,
        status="started",
        started_at="",
    )


@router.post("/{plugin_name}/reload")
async def reload_plugin(plugin_name: str, plugin_manager):
    """Reload a plugin."""
    result = plugin_manager.reload_plugin(plugin_name)
    if not result:
        raise HTTPException(status_code=500, detail=f"Failed to reload {plugin_name}")

    return {"status": "success", "plugin_name": plugin_name}


@router.get("/{plugin_name}/runs")
async def get_plugin_runs(plugin_name: str, limit: int = 10, plugin_manager=None, database=None):
    """Get plugin run history."""
    if not database:
        raise HTTPException(status_code=500, detail="Database not available")

    runs = database.get_plugin_runs(plugin_name=plugin_name, limit=limit)
    return {
        "plugin_name": plugin_name,
        "runs": runs,
    }
