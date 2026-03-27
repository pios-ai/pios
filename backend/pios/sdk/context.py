"""Plugin execution context."""

import logging
from typing import Any, Dict, Optional
from dataclasses import dataclass, field


@dataclass
class PluginContext:
    """Context passed to plugins during execution.

    This provides plugins with access to shared resources like logging,
    LLM, document store, configuration, and database.
    """

    plugin_name: str
    plugin_version: str
    logger: logging.Logger
    config: Dict[str, Any] = field(default_factory=dict)
    llm: Optional[Any] = None
    document_store: Optional[Any] = None
    database: Optional[Any] = None
    scheduler: Optional[Any] = None
    run_id: Optional[str] = None
    run_state: Dict[str, Any] = field(default_factory=dict)

    def log_debug(self, message: str) -> None:
        """Log debug message."""
        self.logger.debug(f"[{self.plugin_name}] {message}")

    def log_info(self, message: str) -> None:
        """Log info message."""
        self.logger.info(f"[{self.plugin_name}] {message}")

    def log_warning(self, message: str) -> None:
        """Log warning message."""
        self.logger.warning(f"[{self.plugin_name}] {message}")

    def log_error(self, message: str) -> None:
        """Log error message."""
        self.logger.error(f"[{self.plugin_name}] {message}")

    def get_config(self, key: str, default: Any = None) -> Any:
        """Get a configuration value.

        Args:
            key: Configuration key
            default: Default value if key not found

        Returns:
            Configuration value
        """
        return self.config.get(key, default)

    def save_run_state(self, state: Dict[str, Any]) -> None:
        """Save run state (for resuming plugins).

        Args:
            state: State dictionary to save
        """
        self.run_state = state
        if self.database:
            import json
            self.database.set_plugin_state(
                self.plugin_name,
                json.dumps(state)
            )

    def load_run_state(self) -> Dict[str, Any]:
        """Load previously saved run state.

        Returns:
            Saved state dictionary or empty dict
        """
        if self.database:
            state_row = self.database.get_plugin_state(self.plugin_name)
            if state_row:
                import json
                return json.loads(state_row.get("state_data", "{}"))
        return {}

    def is_llm_available(self) -> bool:
        """Check if LLM is available.

        Returns:
            True if LLM can be used
        """
        return self.llm is not None and hasattr(self.llm, 'is_available') and self.llm.is_available()
