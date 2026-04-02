"""Scheduler API routes."""

from typing import Dict, Any
from fastapi import APIRouter, HTTPException, Depends

from ..deps import get_scheduler

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])


@router.get("/status")
async def get_scheduler_status(scheduler=Depends(get_scheduler)):
    """Get scheduler status."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    return {
        "running": scheduler.is_running(),
        "enabled": scheduler.enabled,
        "timezone": scheduler.timezone,
        "jobs": scheduler.get_jobs(),
    }


@router.post("/start")
async def start_scheduler(scheduler=Depends(get_scheduler)):
    """Start the scheduler."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    scheduler.start()
    return {"status": "started"}


@router.post("/stop")
async def stop_scheduler(scheduler=Depends(get_scheduler)):
    """Stop the scheduler."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    scheduler.stop()
    return {"status": "stopped"}


@router.get("/jobs")
async def get_jobs(scheduler=Depends(get_scheduler)):
    """Get all scheduled jobs."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    return scheduler.get_jobs()


@router.post("/jobs/{job_id}/pause")
async def pause_job(job_id: str, scheduler=Depends(get_scheduler)):
    """Pause a job."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    scheduler.pause_job(job_id)
    return {"status": "paused"}


@router.post("/jobs/{job_id}/resume")
async def resume_job(job_id: str, scheduler=Depends(get_scheduler)):
    """Resume a job."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    scheduler.resume_job(job_id)
    return {"status": "resumed"}
