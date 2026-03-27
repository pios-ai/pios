"""APScheduler integration for scheduled plugin execution."""

import logging
import uuid
from datetime import datetime
from typing import Optional, Callable, Any
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)


class PiOSScheduler:
    """Wrapper around APScheduler for plugin scheduling."""

    def __init__(self, timezone: str = "UTC", max_workers: int = 4, enabled: bool = True):
        """Initialize scheduler.

        Args:
            timezone: Timezone for cron expressions
            max_workers: Maximum number of concurrent workers
            enabled: Whether scheduling is enabled
        """
        self.timezone = timezone
        self.enabled = enabled
        self.max_workers = max_workers
        self.scheduler = BackgroundScheduler(
            max_instances=max_workers,
            timezone=timezone,
        )
        self._scheduled_jobs = {}

    def start(self) -> None:
        """Start the scheduler."""
        if not self.enabled:
            logger.info("Scheduler is disabled")
            return

        if not self.scheduler.running:
            self.scheduler.start()
            logger.info("Scheduler started")

    def stop(self) -> None:
        """Stop the scheduler."""
        if self.scheduler.running:
            self.scheduler.shutdown()
            logger.info("Scheduler stopped")

    def add_cron_job(
        self,
        func: Callable,
        cron_expression: str,
        job_id: Optional[str] = None,
        args: tuple = (),
        kwargs: Optional[dict] = None,
    ) -> str:
        """Add a job with cron schedule.

        Args:
            func: Function to execute
            cron_expression: Cron expression (minute hour day month day_of_week)
            job_id: Optional job ID
            args: Positional arguments for function
            kwargs: Keyword arguments for function

        Returns:
            Job ID
        """
        if not self.enabled:
            logger.warning("Scheduler is disabled, job not added")
            return ""

        job_id = job_id or str(uuid.uuid4())
        kwargs = kwargs or {}

        try:
            job = self.scheduler.add_job(
                func,
                trigger=CronTrigger.from_crontab(cron_expression, timezone=self.timezone),
                id=job_id,
                args=args,
                kwargs=kwargs,
                replace_existing=True,
            )
            self._scheduled_jobs[job_id] = {
                "func": func.__name__,
                "trigger": "cron",
                "cron": cron_expression,
                "next_run": job.next_run_time,
            }
            logger.info(f"Added cron job {job_id} with schedule: {cron_expression}")
            return job_id
        except Exception as e:
            logger.error(f"Failed to add cron job: {e}")
            raise

    def add_interval_job(
        self,
        func: Callable,
        seconds: int,
        job_id: Optional[str] = None,
        args: tuple = (),
        kwargs: Optional[dict] = None,
    ) -> str:
        """Add a job with interval schedule.

        Args:
            func: Function to execute
            seconds: Interval in seconds
            job_id: Optional job ID
            args: Positional arguments for function
            kwargs: Keyword arguments for function

        Returns:
            Job ID
        """
        if not self.enabled:
            logger.warning("Scheduler is disabled, job not added")
            return ""

        job_id = job_id or str(uuid.uuid4())
        kwargs = kwargs or {}

        try:
            job = self.scheduler.add_job(
                func,
                trigger=IntervalTrigger(seconds=seconds),
                id=job_id,
                args=args,
                kwargs=kwargs,
                replace_existing=True,
            )
            self._scheduled_jobs[job_id] = {
                "func": func.__name__,
                "trigger": "interval",
                "seconds": seconds,
                "next_run": job.next_run_time,
            }
            logger.info(f"Added interval job {job_id} with interval: {seconds}s")
            return job_id
        except Exception as e:
            logger.error(f"Failed to add interval job: {e}")
            raise

    def add_once_job(
        self,
        func: Callable,
        run_at: datetime,
        job_id: Optional[str] = None,
        args: tuple = (),
        kwargs: Optional[dict] = None,
    ) -> str:
        """Add a job to run once at a specific time.

        Args:
            func: Function to execute
            run_at: Datetime to run at
            job_id: Optional job ID
            args: Positional arguments for function
            kwargs: Keyword arguments for function

        Returns:
            Job ID
        """
        if not self.enabled:
            logger.warning("Scheduler is disabled, job not added")
            return ""

        job_id = job_id or str(uuid.uuid4())
        kwargs = kwargs or {}

        try:
            job = self.scheduler.add_job(
                func,
                trigger="date",
                run_date=run_at,
                id=job_id,
                args=args,
                kwargs=kwargs,
                replace_existing=True,
            )
            self._scheduled_jobs[job_id] = {
                "func": func.__name__,
                "trigger": "once",
                "run_at": run_at,
                "next_run": job.next_run_time,
            }
            logger.info(f"Added one-time job {job_id} to run at {run_at}")
            return job_id
        except Exception as e:
            logger.error(f"Failed to add one-time job: {e}")
            raise

    def remove_job(self, job_id: str) -> None:
        """Remove a scheduled job.

        Args:
            job_id: ID of job to remove
        """
        try:
            self.scheduler.remove_job(job_id)
            if job_id in self._scheduled_jobs:
                del self._scheduled_jobs[job_id]
            logger.info(f"Removed job {job_id}")
        except Exception as e:
            logger.error(f"Failed to remove job {job_id}: {e}")

    def pause_job(self, job_id: str) -> None:
        """Pause a scheduled job.

        Args:
            job_id: ID of job to pause
        """
        try:
            job = self.scheduler.get_job(job_id)
            if job:
                job.pause()
                logger.info(f"Paused job {job_id}")
        except Exception as e:
            logger.error(f"Failed to pause job {job_id}: {e}")

    def resume_job(self, job_id: str) -> None:
        """Resume a paused job.

        Args:
            job_id: ID of job to resume
        """
        try:
            job = self.scheduler.get_job(job_id)
            if job:
                job.resume()
                logger.info(f"Resumed job {job_id}")
        except Exception as e:
            logger.error(f"Failed to resume job {job_id}: {e}")

    def get_jobs(self) -> dict:
        """Get all scheduled jobs.

        Returns:
            Dictionary of jobs
        """
        jobs = {}
        for job in self.scheduler.get_jobs():
            jobs[job.id] = {
                "name": job.id,
                "next_run": job.next_run_time,
                "trigger": str(job.trigger),
            }
        return jobs

    def is_running(self) -> bool:
        """Check if scheduler is running.

        Returns:
            True if scheduler is running
        """
        return self.scheduler.running
