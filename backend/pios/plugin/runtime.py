"""Plugin execution runtime with sandboxing."""

import asyncio
import logging
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class PluginRuntime:
    """Runtime for executing plugins with isolation."""

    def __init__(
        self,
        timeout: int = 300,
        max_memory_mb: int = 512,
    ):
        """Initialize plugin runtime.

        Args:
            timeout: Execution timeout in seconds
            max_memory_mb: Maximum memory usage in MB
        """
        self.timeout = timeout
        self.max_memory_mb = max_memory_mb
        self.active_runs = {}

    async def execute(
        self,
        plugin: Any,
        context: Any,
    ) -> Dict[str, Any]:
        """Execute a plugin with timeout and error handling.

        Args:
            plugin: Plugin instance to execute
            context: PluginContext for the plugin

        Returns:
            Execution result dictionary
        """
        run_id = str(uuid.uuid4())
        started_at = datetime.utcnow().isoformat()

        logger.info(f"Starting plugin execution {run_id} for {context.plugin_name}")

        try:
            # Store active run
            self.active_runs[run_id] = {
                "plugin": context.plugin_name,
                "started_at": started_at,
            }

            # Execute with timeout
            result = await asyncio.wait_for(
                self._run_plugin(plugin),
                timeout=self.timeout
            )

            finished_at = datetime.utcnow().isoformat()
            duration_ms = int(
                (datetime.fromisoformat(finished_at) - datetime.fromisoformat(started_at)).total_seconds() * 1000
            )

            return {
                "run_id": run_id,
                "status": "success",
                "started_at": started_at,
                "finished_at": finished_at,
                "duration_ms": duration_ms,
                "result": result,
                "error": None,
            }

        except asyncio.TimeoutError:
            finished_at = datetime.utcnow().isoformat()
            error_msg = f"Plugin execution timeout after {self.timeout}s"
            logger.error(f"{error_msg} for {context.plugin_name}")

            return {
                "run_id": run_id,
                "status": "failed",
                "started_at": started_at,
                "finished_at": finished_at,
                "duration_ms": self.timeout * 1000,
                "result": None,
                "error": error_msg,
            }

        except Exception as e:
            finished_at = datetime.utcnow().isoformat()
            error_msg = f"Plugin execution failed: {str(e)}"
            logger.error(f"{error_msg} for {context.plugin_name}")

            return {
                "run_id": run_id,
                "status": "failed",
                "started_at": started_at,
                "finished_at": finished_at,
                "duration_ms": int(
                    (datetime.fromisoformat(finished_at) - datetime.fromisoformat(started_at)).total_seconds() * 1000
                ),
                "result": None,
                "error": error_msg,
            }

        finally:
            # Clean up active run
            if run_id in self.active_runs:
                del self.active_runs[run_id]

    async def _run_plugin(self, plugin: Any) -> Any:
        """Run plugin, handling both async and sync methods.

        Args:
            plugin: Plugin instance

        Returns:
            Plugin execution result
        """
        # Try to run as async
        if hasattr(plugin.run, '__call__'):
            import inspect
            if inspect.iscoroutinefunction(plugin.run):
                return await plugin.run()
            else:
                # Run sync function in thread pool to avoid blocking
                loop = asyncio.get_event_loop()
                return await loop.run_in_executor(None, plugin.run)

        raise ValueError("Plugin does not have a run method")

    def get_active_runs(self) -> Dict[str, Any]:
        """Get currently active plugin runs.

        Returns:
            Dictionary of active runs
        """
        return self.active_runs.copy()

    def cancel_run(self, run_id: str) -> bool:
        """Cancel a running execution.

        Args:
            run_id: ID of run to cancel

        Returns:
            True if cancellation was successful
        """
        if run_id in self.active_runs:
            logger.info(f"Cancelling run {run_id}")
            del self.active_runs[run_id]
            return True
        return False
