"""System API routes."""

from typing import Dict, Any
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/status")
async def get_system_status(
    config=None,
    database=None,
    scheduler=None,
    plugin_manager=None,
) -> Dict[str, Any]:
    """Get overall system status."""
    db_status = "disconnected"
    if database:
        try:
            stats = database.get_stats()
            db_status = "connected"
        except Exception as e:
            db_status = f"error: {str(e)}"

    scheduler_status = "stopped"
    if scheduler:
        scheduler_status = "running" if scheduler.is_running() else "stopped"

    plugins_loaded = 0
    if plugin_manager:
        plugins_loaded = len(plugin_manager.instances)

    return {
        "app_name": config.app_name if config else "PiOS",
        "debug": config.debug if config else False,
        "database": {
            "status": db_status,
            "type": config.database.type if config else "sqlite",
        },
        "scheduler": {
            "status": scheduler_status,
            "enabled": scheduler.enabled if scheduler else False,
        },
        "plugins": {
            "loaded": plugins_loaded,
        },
    }


@router.get("/health")
async def health_check() -> Dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy"}


@router.get("/config")
async def get_config(config=None) -> Dict[str, Any]:
    """Get current configuration (non-sensitive)."""
    if not config:
        raise HTTPException(status_code=500, detail="Config not available")

    return {
        "app_name": config.app_name,
        "debug": config.debug,
        "log_level": config.log_level,
        "scheduler": {
            "enabled": config.scheduler.enabled,
            "timezone": config.scheduler.timezone,
            "max_workers": config.scheduler.max_workers,
        },
        "storage": {
            "vault_path": config.storage.vault_path,
            "index_type": config.storage.index_type,
        },
    }


@router.get("/version")
async def get_version() -> Dict[str, str]:
    """Get PiOS version."""
    from pios import __version__

    return {"version": __version__}
