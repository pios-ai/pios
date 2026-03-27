"""FastAPI application entry point for PiOS."""

import logging
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .core.config import PiOSConfig
from .core.database import Database
from .core.llm import LLMClient
from .core.scheduler import PiOSScheduler
from .document.store import DocumentStore
from .plugin.manager import PluginManager
from .api import plugins, documents, scheduler, system

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global instances
_config: PiOSConfig = None
_database: Database = None
_document_store: DocumentStore = None
_llm: LLMClient = None
_scheduler: PiOSScheduler = None
_plugin_manager: PluginManager = None


def get_config() -> PiOSConfig:
    """Get config dependency."""
    return _config


def get_database() -> Database:
    """Get database dependency."""
    return _database


def get_document_store() -> DocumentStore:
    """Get document store dependency."""
    return _document_store


def get_llm() -> LLMClient:
    """Get LLM dependency."""
    return _llm


def get_scheduler() -> PiOSScheduler:
    """Get scheduler dependency."""
    return _scheduler


def get_plugin_manager() -> PluginManager:
    """Get plugin manager dependency."""
    return _plugin_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global _config, _database, _document_store, _llm, _scheduler, _plugin_manager

    logger.info("Starting PiOS")

    # Load configuration
    _config = PiOSConfig.from_file()
    _config.ensure_directories()
    logger.info(f"Config: {_config.app_name}")

    # Initialize database
    _database = Database(_config.database.path)
    _database.init_schema()

    # Initialize document store
    _document_store = DocumentStore(_config.storage.vault_path, _database)

    # Initialize LLM
    _llm = LLMClient(
        provider=_config.llm.provider,
        model=_config.llm.model,
        api_key=_config.llm.api_key,
        temperature=_config.llm.temperature,
        max_tokens=_config.llm.max_tokens,
    )

    # Initialize scheduler
    _scheduler = PiOSScheduler(
        timezone=_config.scheduler.timezone,
        max_workers=_config.scheduler.max_workers,
        enabled=_config.scheduler.enabled,
    )

    # Initialize plugin manager
    _plugin_manager = PluginManager(
        plugin_dirs=_config.plugin_dirs,
        database=_database,
        document_store=_document_store,
        scheduler=_scheduler,
        llm=_llm,
    )

    # Discover and load plugins
    plugins_found = _plugin_manager.discover_plugins()
    logger.info(f"Found {len(plugins_found)} plugins")

    for plugin_name in plugins_found:
        try:
            _plugin_manager.load_plugin(plugin_name)
        except Exception as e:
            logger.error(f"Failed to load plugin {plugin_name}: {e}")

    # Start scheduler
    _scheduler.start()

    yield

    # Shutdown
    logger.info("Shutting down PiOS")
    _scheduler.stop()
    _database.disconnect()


# Create FastAPI app
app = FastAPI(
    title="PiOS API",
    description="Personal Intelligence OS API",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers with dependencies
app.include_router(
    system.router,
    dependencies=[
        Depends(get_config),
        Depends(get_database),
        Depends(get_scheduler),
        Depends(get_plugin_manager),
    ]
)

app.include_router(
    plugins.router,
    dependencies=[Depends(get_plugin_manager), Depends(get_database)]
)

app.include_router(
    documents.router,
    dependencies=[Depends(get_database), Depends(get_document_store)]
)

app.include_router(
    scheduler.router,
    dependencies=[Depends(get_scheduler)]
)


# Root endpoint
@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "app": "PiOS",
        "version": "0.1.0",
        "endpoints": [
            "/api/system",
            "/api/plugins",
            "/api/documents",
            "/api/scheduler",
            "/docs",
        ],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
