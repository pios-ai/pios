"""Plugin discovery, lifecycle, and execution management."""

import logging
import importlib.util
import sys
from pathlib import Path
from typing import Dict, List, Optional, Any

import yaml

from .models import PluginManifest, PluginStatus
from .runtime import PluginRuntime
from ..sdk.context import PluginContext

logger = logging.getLogger(__name__)


class PluginManager:
    """Manages plugin discovery, loading, and execution."""

    def __init__(
        self,
        plugin_dirs: List[str],
        database: Any,
        document_store: Any,
        scheduler: Any,
        llm: Any,
    ):
        """Initialize plugin manager.

        Args:
            plugin_dirs: List of directories to search for plugins
            database: Database instance
            document_store: DocumentStore instance
            scheduler: PiOSScheduler instance
            llm: LLMClient instance
        """
        self.plugin_dirs = [Path(d) for d in plugin_dirs]
        self.database = database
        self.document_store = document_store
        self.scheduler = scheduler
        self.llm = llm
        self.runtime = PluginRuntime()

        self.plugins: Dict[str, Any] = {}
        self.manifests: Dict[str, PluginManifest] = {}
        self.instances: Dict[str, Any] = {}
        self.runs: Dict[str, Any] = {}

    def discover_plugins(self) -> List[str]:
        """Discover plugins in plugin directories.

        Returns:
            List of discovered plugin names
        """
        discovered = []

        for plugin_dir in self.plugin_dirs:
            if not plugin_dir.exists():
                logger.debug(f"Plugin directory does not exist: {plugin_dir}")
                continue

            logger.info(f"Discovering plugins in {plugin_dir}")

            for item in plugin_dir.iterdir():
                if item.is_dir() and not item.name.startswith("_"):
                    if self._load_plugin_manifest(item):
                        discovered.append(item.name)

        logger.info(f"Discovered {len(discovered)} plugins: {discovered}")
        return discovered

    def _load_plugin_manifest(self, plugin_path: Path) -> bool:
        """Load and validate plugin manifest.

        Args:
            plugin_path: Path to plugin directory

        Returns:
            True if manifest loaded successfully
        """
        manifest_file = plugin_path / "plugin.yaml"

        if not manifest_file.exists():
            logger.debug(f"No manifest found in {plugin_path}")
            return False

        try:
            with open(manifest_file, "r") as f:
                manifest_data = yaml.safe_load(f)

            if not manifest_data:
                logger.warning(f"Empty manifest in {plugin_path}")
                return False

            # Validate manifest
            manifest = PluginManifest(**manifest_data)
            self.manifests[manifest.name] = manifest
            self.plugins[manifest.name] = plugin_path

            logger.info(f"Loaded manifest for {manifest.name} v{manifest.version}")
            return True

        except Exception as e:
            logger.error(f"Error loading manifest from {plugin_path}: {e}")
            return False

    def load_plugin(self, plugin_name: str) -> Optional[Any]:
        """Load and instantiate a plugin.

        Args:
            plugin_name: Name of plugin to load

        Returns:
            Plugin instance or None if failed
        """
        if plugin_name in self.instances:
            return self.instances[plugin_name]

        if plugin_name not in self.plugins:
            logger.error(f"Plugin {plugin_name} not found")
            return None

        plugin_path = self.plugins[plugin_name]
        manifest = self.manifests[plugin_name]

        try:
            # Load plugin module
            init_file = plugin_path / "__init__.py"

            if not init_file.exists():
                logger.error(f"No __init__.py in {plugin_path}")
                return None

            spec = importlib.util.spec_from_file_location(plugin_name, init_file)
            module = importlib.util.module_from_spec(spec)
            sys.modules[plugin_name] = module
            spec.loader.exec_module(module)

            # Get plugin class
            plugin_class = None
            if hasattr(module, "Plugin"):
                plugin_class = module.Plugin
            else:
                # Try to find a class extending SourcePlugin or AgentPlugin
                from ..sdk.source import SourcePlugin
                from ..sdk.agent import AgentPlugin

                for attr_name in dir(module):
                    attr = getattr(module, attr_name)
                    if isinstance(attr, type):
                        if issubclass(attr, (SourcePlugin, AgentPlugin)):
                            if attr not in (SourcePlugin, AgentPlugin):
                                plugin_class = attr
                                break

            if not plugin_class:
                logger.error(f"Could not find plugin class in {plugin_name}")
                return None

            # Create context
            context = PluginContext(
                plugin_name=manifest.name,
                plugin_version=manifest.version,
                logger=logger,
                config=manifest.config_schema.copy(),
                llm=self.llm,
                document_store=self.document_store,
                database=self.database,
                scheduler=self.scheduler,
            )

            # Instantiate plugin
            plugin_instance = plugin_class(context)

            # Schedule if needed
            if manifest.schedule:
                self.scheduler.add_cron_job(
                    func=lambda: self._run_plugin_sync(plugin_name),
                    cron_expression=manifest.schedule,
                    job_id=f"plugin-{plugin_name}",
                )
                logger.info(f"Scheduled {plugin_name} with cron: {manifest.schedule}")

            self.instances[plugin_name] = plugin_instance
            logger.info(f"Loaded plugin {plugin_name}")

            return plugin_instance

        except Exception as e:
            logger.error(f"Error loading plugin {plugin_name}: {e}")
            return None

    def _run_plugin_sync(self, plugin_name: str) -> Dict[str, Any]:
        """Run plugin synchronously (for scheduler).

        Args:
            plugin_name: Name of plugin to run

        Returns:
            Run result
        """
        import asyncio

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(self.run_plugin(plugin_name))
        finally:
            loop.close()

    async def run_plugin(self, plugin_name: str) -> Dict[str, Any]:
        """Execute a plugin.

        Args:
            plugin_name: Name of plugin to run

        Returns:
            Execution result
        """
        if plugin_name not in self.instances:
            plugin = self.load_plugin(plugin_name)
            if not plugin:
                return {
                    "status": "failed",
                    "error": f"Plugin {plugin_name} not found",
                }
        else:
            plugin = self.instances[plugin_name]

        manifest = self.manifests.get(plugin_name)
        context = plugin.context if hasattr(plugin, "context") else None

        result = await self.runtime.execute(plugin, context)

        # Store run record in database
        if self.database:
            self.database.insert_plugin_run(
                run_id=result["run_id"],
                plugin_name=plugin_name,
                started_at=result["started_at"],
                finished_at=result.get("finished_at"),
                status=result["status"],
                documents_created=0,
                error_message=result.get("error"),
                duration_ms=result.get("duration_ms"),
            )

        return result

    def get_plugin_status(self, plugin_name: str) -> Optional[PluginStatus]:
        """Get status of a plugin.

        Args:
            plugin_name: Name of plugin

        Returns:
            PluginStatus or None if not found
        """
        if plugin_name not in self.manifests:
            return None

        manifest = self.manifests[plugin_name]

        # Get last run
        runs = self.database.get_plugin_runs(plugin_name=plugin_name, limit=1)
        last_run_status = runs[0]["status"] if runs else None
        last_run_time = runs[0]["started_at"] if runs else None

        # Get next scheduled run
        next_run = None
        if manifest.schedule:
            job = self.scheduler.scheduler.get_job(f"plugin-{plugin_name}")
            if job:
                nrt = getattr(job, "next_run_time", None)
                next_run = nrt.isoformat() if nrt else None

        return PluginStatus(
            name=manifest.name,
            version=manifest.version,
            type=manifest.type,
            enabled=plugin_name in self.instances,
            last_run=last_run_time,
            last_run_status=last_run_status,
            next_run=next_run,
        )

    def get_all_plugins(self) -> List[PluginStatus]:
        """Get status of all plugins.

        Returns:
            List of PluginStatus objects
        """
        return [self.get_plugin_status(name) for name in self.manifests.keys()]

    def unload_plugin(self, plugin_name: str) -> bool:
        """Unload a plugin.

        Args:
            plugin_name: Name of plugin to unload

        Returns:
            True if successful
        """
        if plugin_name in self.instances:
            del self.instances[plugin_name]
            logger.info(f"Unloaded plugin {plugin_name}")
            return True
        return False

    def reload_plugin(self, plugin_name: str) -> Optional[Any]:
        """Reload a plugin.

        Args:
            plugin_name: Name of plugin to reload

        Returns:
            Reloaded plugin instance or None
        """
        self.unload_plugin(plugin_name)
        return self.load_plugin(plugin_name)
