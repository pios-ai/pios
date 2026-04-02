"""Configuration system for PiOS with YAML loading and Pydantic validation."""

import os
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
import yaml
from pydantic import BaseModel, Field, model_validator
from pydantic import ConfigDict

logger = logging.getLogger(__name__)


class LLMConfig(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: str = Field(default="openai")
    model: str = Field(default="gpt-4")
    api_key: str = Field(default="")
    base_url: Optional[str] = Field(default=None)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=2000, gt=0)


class DatabaseConfig(BaseModel):
    type: str = Field(default="sqlite")
    path: str = Field(default="~/.pios/pios.db")
    echo: bool = Field(default=False)

    @model_validator(mode="after")
    def expand_path(self) -> "DatabaseConfig":
        self.path = str(Path(self.path).expanduser())
        return self


class SchedulerConfig(BaseModel):
    enabled: bool = Field(default=True)
    timezone: str = Field(default="UTC")
    max_workers: int = Field(default=4, gt=0)


class StorageConfig(BaseModel):
    vault_path: str = Field(default="~/.pios/vault")
    max_file_size_mb: int = Field(default=100, gt=0)
    index_type: str = Field(default="sqlite")

    @model_validator(mode="after")
    def expand_vault_path(self) -> "StorageConfig":
        self.vault_path = str(Path(self.vault_path).expanduser())
        return self


class PiOSConfig(BaseModel):
    model_config = ConfigDict(extra="allow")

    app_name: str = Field(default="PiOS")
    debug: bool = Field(default=False)
    log_level: str = Field(default="INFO")
    llm: LLMConfig = Field(default_factory=LLMConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    scheduler: SchedulerConfig = Field(default_factory=SchedulerConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    plugin_dirs: List[str] = Field(
        default=["~/.pios/plugins", "./plugins"],
    )
    # Per-plugin config overrides: {plugin_name: {key: value}}
    plugin_configs: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def expand_plugin_dirs(self) -> "PiOSConfig":
        self.plugin_dirs = [str(Path(d).expanduser()) for d in self.plugin_dirs]
        return self

    def __init__(self, **data):
        interpolated = self._interpolate_env_vars(data)
        super().__init__(**interpolated)

    @staticmethod
    def _interpolate_env_vars(obj: Any) -> Any:
        """Recursively interpolate ${ENV_VAR} references in config values."""
        if isinstance(obj, dict):
            return {k: PiOSConfig._interpolate_env_vars(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [PiOSConfig._interpolate_env_vars(item) for item in obj]
        elif isinstance(obj, str):
            import re
            def replace_env(match):
                env_var = match.group(1)
                default = match.group(2) if match.group(2) else ""
                return os.getenv(env_var, default)
            return re.sub(r"\$\{([^}:]+)(?::([^}]+))?\}", replace_env, obj)
        return obj

    @classmethod
    def from_file(cls, config_path: Optional[str] = None) -> "PiOSConfig":
        """Load configuration from YAML file, falling back to defaults."""
        if config_path is None:
            for loc in [
                Path.home() / ".pios" / "config.yaml",
                Path.home() / ".pios" / "config.yml",
                Path(".") / "config.yaml",
            ]:
                if loc.exists():
                    config_path = str(loc)
                    break

        if config_path and Path(config_path).exists():
            logger.info(f"Loading config from {config_path}")
            with open(config_path, "r") as f:
                data = yaml.safe_load(f) or {}
            return cls(**data)

        logger.info("No config file found, using defaults")
        return cls()

    @classmethod
    def create_default(cls, config_path: Optional[str] = None) -> Path:
        """Write a default configuration file to disk."""
        if config_path is None:
            config_path = Path.home() / ".pios" / "config.yaml"
        else:
            config_path = Path(config_path)

        config_path.parent.mkdir(parents=True, exist_ok=True)
        config = cls()

        with open(config_path, "w") as f:
            yaml.dump(config.model_dump(exclude_unset=True), f,
                      default_flow_style=False, sort_keys=False)

        logger.info(f"Created default config at {config_path}")
        return config_path

    def ensure_directories(self) -> None:
        """Create required directories if they don't exist."""
        Path(self.storage.vault_path).mkdir(parents=True, exist_ok=True)
        Path(self.database.path).parent.mkdir(parents=True, exist_ok=True)
        for plugin_dir in self.plugin_dirs:
            Path(plugin_dir).mkdir(parents=True, exist_ok=True)
