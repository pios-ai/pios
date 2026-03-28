"""Plugin API routes."""

import json
from typing import Any, Dict, List, Optional
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
    schedule: Optional[str] = None
    last_run: Optional[str] = None
    last_run_status: Optional[str] = None
    next_run: Optional[str] = None


class PluginRunResponse(BaseModel):
    run_id: str
    plugin_name: str
    status: str
    started_at: str


def _to_plugin_info(p, plugin_manager) -> PluginInfo:
    manifest = plugin_manager.manifests.get(p.name)
    return PluginInfo(
        name=p.name,
        version=p.version,
        type=p.type,
        description=manifest.description if manifest else "",
        enabled=p.enabled,
        schedule=manifest.schedule if manifest else None,
        last_run=p.last_run,
        last_run_status=p.last_run_status,
        next_run=p.next_run,
    )


@router.get("/", response_model=List[PluginInfo])
async def list_plugins(plugin_manager=Depends(get_plugin_manager)):
    """List all discovered plugins."""
    if not plugin_manager:
        return []
    return [_to_plugin_info(p, plugin_manager) for p in plugin_manager.get_all_plugins()]


@router.get("/{plugin_name}", response_model=PluginInfo)
async def get_plugin(plugin_name: str, plugin_manager=Depends(get_plugin_manager)):
    """Get plugin information."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    status = plugin_manager.get_plugin_status(plugin_name)
    if not status:
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")
    return _to_plugin_info(status, plugin_manager)


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


@router.get("/{plugin_name}/config")
async def get_plugin_config(
    plugin_name: str,
    plugin_manager=Depends(get_plugin_manager),
    database=Depends(get_database),
):
    """Get plugin config schema and current values."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    manifest = plugin_manager.manifests.get(plugin_name)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")

    schema = manifest.config_schema or {}

    # Build current values: schema defaults → yaml overrides → DB overrides
    current: Dict[str, Any] = {}
    for key, schema_val in schema.items():
        if isinstance(schema_val, dict) and "default" in schema_val:
            current[key] = schema_val["default"]

    yaml_overrides = plugin_manager.plugin_configs.get(plugin_name, {})
    current.update(yaml_overrides)

    if database:
        db_cfg = database.get_plugin_config(plugin_name)
        if db_cfg and db_cfg.get("config_overrides"):
            try:
                current.update(json.loads(db_cfg["config_overrides"]))
            except Exception:
                pass

    return {"plugin_name": plugin_name, "schema": schema, "current": current}


@router.post("/{plugin_name}/configure")
async def configure_plugin(
    plugin_name: str,
    config: Dict[str, Any],
    plugin_manager=Depends(get_plugin_manager),
    database=Depends(get_database),
):
    """Update plugin configuration (persisted to DB)."""
    if not plugin_manager:
        raise HTTPException(status_code=500, detail="Plugin manager not available")
    if plugin_name not in plugin_manager.manifests:
        raise HTTPException(status_code=404, detail=f"Plugin {plugin_name} not found")
    if not database:
        raise HTTPException(status_code=500, detail="Database not available")

    database.set_plugin_config_overrides(plugin_name, json.dumps(config))

    # Hot-reload the plugin so new config takes effect immediately
    plugin_manager.reload_plugin(plugin_name)

    return {"status": "configured", "plugin_name": plugin_name, "config": config}
