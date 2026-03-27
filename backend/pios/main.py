"""FastAPI application entry point for PiOS."""

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import PiOSConfig
from .core.database import Database
from .core.llm import LLMClient
from .core.scheduler import PiOSScheduler
from .document.store import DocumentStore
from .plugin.manager import PluginManager
from .api import plugins, documents, scheduler, system
from . import deps

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    logger.info("Starting PiOS")

    # Load configuration
    deps._config = PiOSConfig.from_file()
    deps._config.ensure_directories()
    logger.info(f"Config loaded: {deps._config.app_name}")

    # Initialize database
    deps._database = Database(deps._config.database.path)
    deps._database.init_schema()

    # Initialize document store
    deps._document_store = DocumentStore(deps._config.storage.vault_path, deps._database)

    # Initialize LLM (lazy – no crash if no API key)
    deps._llm = LLMClient(
        provider=deps._config.llm.provider,
        model=deps._config.llm.model,
        api_key=deps._config.llm.api_key,
        temperature=deps._config.llm.temperature,
        max_tokens=deps._config.llm.max_tokens,
    )

    # Initialize scheduler
    deps._scheduler = PiOSScheduler(
        timezone=deps._config.scheduler.timezone,
        max_workers=deps._config.scheduler.max_workers,
        enabled=deps._config.scheduler.enabled,
    )

    # Initialize plugin manager
    deps._plugin_manager = PluginManager(
        plugin_dirs=deps._config.plugin_dirs,
        database=deps._database,
        document_store=deps._document_store,
        scheduler=deps._scheduler,
        llm=deps._llm,
    )

    # Discover and load plugins
    plugins_found = deps._plugin_manager.discover_plugins()
    logger.info(f"Found {len(plugins_found)} plugins")

    for plugin_name in plugins_found:
        try:
            deps._plugin_manager.load_plugin(plugin_name)
        except Exception as e:
            logger.error(f"Failed to load plugin {plugin_name}: {e}")

    # Start scheduler
    deps._scheduler.start()

    yield

    # Shutdown
    logger.info("Shutting down PiOS")
    deps._scheduler.stop()
    deps._database.disconnect()


app = FastAPI(
    title="PiOS API",
    description="Personal Intelligence OS API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system.router)
app.include_router(plugins.router)
app.include_router(documents.router)
app.include_router(scheduler.router)


@app.get("/")
async def root():
    return {
        "app": "PiOS",
        "version": "0.1.0",
        "endpoints": ["/api/system", "/api/plugins", "/api/documents", "/api/scheduler", "/docs"],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
