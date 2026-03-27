"""Scheduler API routes."""

from typing import Dict, Any
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])


@router.get("/status")
async def get_scheduler_status(scheduler=None):
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
async def start_scheduler(scheduler=None):
    """Start the scheduler."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")

    scheduler.start()
    return {"status": "started"}


@router.post("/stop")
async def stop_scheduler(scheduler=None):
    """Stop the scheduler."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")

    scheduler.stop()
    return {"status": "stopped"}


@router.get("/jobs")
async def get_jobs(scheduler=None):
    """Get all scheduled jobs."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")

    return scheduler.get_jobs()


@router.post("/jobs/{job_id}/pause")
async def pause_job(job_id: str, scheduler=None):
    """Pause a job."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")

    scheduler.pause_job(job_id)
    return {"status": "paused"}


@router.post("/jobs/{job_id}/resume")
async def resume_job(job_id: str, scheduler=None):
    """Resume a job."""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not available")

    scheduler.resume_job(job_id)
    return {"status": "resumed"}
