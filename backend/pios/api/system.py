"""System API routes."""

from typing import Dict, Any
from fastapi import APIRouter, Depends

from ..deps import get_config, get_database, get_scheduler, get_plugin_manager, get_llm

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/status")
async def get_system_status(
    config=Depends(get_config),
    database=Depends(get_database),
    scheduler=Depends(get_scheduler),
    plugin_manager=Depends(get_plugin_manager),
    llm=Depends(get_llm),
) -> Dict[str, Any]:
    """Get overall system status."""
    db_status = "disconnected"
    if database:
        try:
            database.get_stats()
            db_status = "connected"
        except Exception as e:
            db_status = f"error: {str(e)}"

    scheduler_status = "stopped"
    job_count = 0
    if scheduler:
        scheduler_status = "running" if scheduler.is_running() else "stopped"
        try:
            job_count = len(scheduler.scheduler.get_jobs())
        except Exception:
            pass

    plugins_loaded = 0
    if plugin_manager:
        plugins_loaded = len(plugin_manager.instances)

    llm_info = {}
    if config:
        llm_info = {
            "provider": config.llm.provider,
            "model": config.llm.model,
            "available": llm.is_available() if llm else False,
        }

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
            "jobs": job_count,
        },
        "plugins": {
            "loaded": plugins_loaded,
        },
        "llm": llm_info,
    }


@router.get("/health")
async def health_check() -> Dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy"}


@router.get("/config")
async def get_config_endpoint(config=Depends(get_config)) -> Dict[str, Any]:
    """Get current configuration (non-sensitive)."""
    if not config:
        from fastapi import HTTPException
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
