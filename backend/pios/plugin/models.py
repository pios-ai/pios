"""Plugin data models."""

from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict


class PluginManifest(BaseModel):
    """Plugin manifest structure from plugin.yaml."""

    model_config = ConfigDict(extra="allow")

    name: str
    version: str
    type: str  # "source" or "agent"
    description: str
    author: Optional[str] = None
    homepage: Optional[str] = None
    license: Optional[str] = None
    config_schema: Dict[str, Any] = {}
    schedule: Optional[str] = None  # Cron expression
    outputs: List[str] = []
    permissions: List[str] = []
    dependencies: List[str] = []


@dataclass
class PluginRun:
    """Record of a plugin execution."""

    run_id: str
    plugin_name: str
    plugin_version: str
    started_at: str
    finished_at: Optional[str] = None
    status: str = "running"  # running, success, failed
    documents_created: int = 0
    error_message: Optional[str] = None
    duration_ms: Optional[int] = None
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)


@dataclass
class PluginStatus:
    """Current status of a plugin."""

    name: str
    version: str
    type: str
    enabled: bool = True
    last_run: Optional[str] = None
    last_run_status: Optional[str] = None
    next_run: Optional[str] = None
    documents_created: int = 0
    error_count: int = 0
    custom_status: Dict[str, Any] = None

    def __post_init__(self):
        if self.custom_status is None:
            self.custom_status = {}

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = asdict(self)
        return result
