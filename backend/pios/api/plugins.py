"""Plugin API routes."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel

from ..deps import get_plugin_manager, get_database

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class PluginInfo(BaseModel):
    name: str
    version: str
    type: str
    description: str
    enabled: bool
    last_run: Optional[str] = None


class PluginRunResponse(BaseModel):
    run_id: str
    plugin_name: str
    status: str
    started_at: str


@router.get("/", response_model=List[PluginInfo])
async def list_plugins(plugin_manager=Depends(get_plugin_manager)):
    """List all discovered plugins."""
    if not plugin_manager:
        return []
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
async def get_plugin(plugin_name: str, plugin_manager=Depends(get_plugin_manager)):
    """Get plugin information."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
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
    plugin_manager=Depends(get_plugin_manager),
):
    """Trigger a plugin run."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    if plugin_name not in plugin_manager.manifests:
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")

    import uuid
    from datetime import datetime
    run_id = str(uuid.uuid4())
    background_tasks.add_task(plugin_manager.run_plugin, plugin_name)

    return PluginRunResponse(
        run_id=run_id,
        plugin_name=plugin_name,
        status="started",
        started_at=datetime.utcnow().isoformat(),
    )


@router.post("/{plugin_name}/enable")
async def enable_plugin(plugin_name: str, plugin_manager=Depends(get_plugin_manager)):
    """Enable a plugin."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    if not plugin_manager.enable_plugin(plugin_name):
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")
    return {"status": "enabled", "plugin_name": plugin_name}


@router.post("/{plugin_name}/disable")
async def disable_plugin(plugin_name: str, plugin_manager=Depends(get_plugin_manager)):
    """Disable a plugin."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    if not plugin_manager.disable_plugin(plugin_name):
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")
    return {"status": "disabled", "plugin_name": plugin_name}


@router.post("/{plugin_name}/reload")
async def reload_plugin(plugin_name: str, plugin_manager=Depends(get_plugin_manager)):
    """Reload a plugin."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    result = plugin_manager.reload_plugin(plugin_name)
    if not result:
        raise HTTPException(status_code=500, detail=f"Failed to reload {plugin_name}")
    return {"status": "success", "plugin_name": plugin_name}


@router.get("/{plugin_name}/runs")
async def get_plugin_runs(
    plugin_name: str,
    limit: int = 10,
    database=Depends(get_database),
):
    """Get plugin run history."""
    if not database:
        raise HTTPException(status_code=500, detail="Database not available")
    runs = database.get_plugin_runs(plugin_name=plugin_name, limit=limit)
    return {"plugin_name": plugin_name, "runs": runs}
