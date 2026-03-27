"""Base class for source plugins that fetch data."""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from dataclasses import dataclass
from .context import PluginContext


@dataclass
class SourceData:
    """Data fetched from a source."""

    source: str
    data_type: str
    content: Any
    title: Optional[str] = None
    date: Optional[str] = None
    tags: Optional[List[str]] = None
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


class SourcePlugin(ABC):
    """Base class for plugins that fetch data from external sources.

    Source plugins are responsible for:
    1. Connecting to external data sources (APIs, files, etc.)
    2. Fetching raw data
    3. Normalizing data into a standard format
    4. Creating documents in the vault
    """

    def __init__(self, context: PluginContext):
        """Initialize source plugin.

        Args:
            context: Plugin execution context
        """
        self.context = context
        self.logger = context.logger

    @abstractmethod
    def fetch(self) -> List[SourceData]:
        """Fetch data from the source.

        Must be implemented by subclasses. Should:
        - Connect to the external source
        - Retrieve raw data
        - Handle errors gracefully
        - Return list of SourceData objects

        Returns:
            List of SourceData objects
        """
        pass

    @abstractmethod
    def normalize(self, data: SourceData) -> Dict[str, Any]:
        """Normalize raw data to standard format.

        Must be implemented by subclasses. Should:
        - Extract relevant fields
        - Apply consistent formatting
        - Add metadata

        Args:
            data: Raw SourceData object

        Returns:
            Normalized data dictionary
        """
        pass

    async def run(self) -> int:
        """Execute the plugin.

        This is the main execution method. It:
        1. Calls fetch() to get raw data
        2. Normalizes each item
        3. Saves documents to vault
        4. Updates database
        5. Returns count of documents created

        Returns:
            Number of documents created
        """
        documents_created = 0

        try:
            self.logger.info(f"{self.context.plugin_name} starting fetch")

            # Fetch raw data
            raw_data = self.fetch()
            self.logger.info(f"Fetched {len(raw_data)} items from source")

            # Process each item
            for item in raw_data:
                try:
                    # Normalize data
                    normalized = self.normalize(item)

                    # Save to document store
                    if self.context.document_store:
                        doc_id = self.context.document_store.save(
                            source=self.context.plugin_name,
                            data_type=item.data_type,
                            content=normalized,
                            title=item.title,
                            date=item.date,
                            tags=item.tags,
                        )
                        documents_created += 1
                        self.logger.debug(f"Saved document {doc_id}")

                except Exception as e:
                    self.logger.error(f"Error processing item: {e}")
                    continue

            self.logger.info(
                f"{self.context.plugin_name} completed, "
                f"created {documents_created} documents"
            )

            return documents_created

        except Exception as e:
            self.logger.error(f"Error in plugin execution: {e}")
            raise

    def validate_config(self) -> bool:
        """Validate plugin configuration.

        Override to implement custom validation.
        Should raise exception if config is invalid.

        Returns:
            True if config is valid
        """
        return True

    def get_status(self) -> Dict[str, Any]:
        """Get plugin status.

        Override to provide custom status information.

        Returns:
            Status dictionary
        """
        return {
            "name": self.context.plugin_name,
            "version": self.context.plugin_version,
            "status": "idle",
        }
