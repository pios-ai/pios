"""Base class for agent plugins that process and analyze data."""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from .context import PluginContext


class AgentPlugin(ABC):
    """Base class for agent plugins that process and analyze data.

    Agent plugins are responsible for:
    1. Querying the document vault
    2. Processing/analyzing documents
    3. Using LLM for reasoning
    4. Creating derived documents (reports, summaries, etc.)
    5. Taking actions based on analysis
    """

    def __init__(self, context: PluginContext):
        """Initialize agent plugin.

        Args:
            context: Plugin execution context
        """
        self.context = context
        self.logger = context.logger

    @abstractmethod
    async def run(self) -> Dict[str, Any]:
        """Execute the agent.

        Must be implemented by subclasses. Should:
        - Query documents from vault
        - Process/analyze them
        - Use LLM if needed
        - Create derived documents
        - Return results

        Returns:
            Dictionary with execution results
        """
        pass

    def query_documents(
        self,
        source: Optional[str] = None,
        doc_type: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Query documents from the vault.

        Args:
            source: Filter by source plugin
            doc_type: Filter by document type
            limit: Maximum results to return

        Returns:
            List of documents
        """
        if not self.context.database:
            self.logger.warning("Database not available")
            return []

        return self.context.database.get_documents(
            source=source,
            doc_type=doc_type,
            limit=limit,
        )

    def save_document(
        self,
        title: str,
        content: str,
        doc_type: str = "analysis",
        tags: Optional[List[str]] = None,
    ) -> Optional[str]:
        """Save a document to the vault.

        Args:
            title: Document title
            content: Document content
            doc_type: Type of document
            tags: Tags for the document

        Returns:
            Document ID or None if failed
        """
        if not self.context.document_store:
            self.logger.warning("Document store not available")
            return None

        return self.context.document_store.save(
            source=f"{self.context.plugin_name}-output",
            data_type=doc_type,
            content={"text": content},
            title=title,
            tags=tags,
        )

    def use_llm(
        self,
        prompt: str,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
    ) -> Optional[str]:
        """Use the LLM for reasoning/analysis.

        Args:
            prompt: Prompt to send to LLM
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate

        Returns:
            LLM response or None if LLM unavailable
        """
        if not self.context.is_llm_available():
            self.logger.warning("LLM not available")
            return None

        try:
            messages = [{"role": "user", "content": prompt}]
            kwargs = {}
            if max_tokens:
                kwargs["max_tokens"] = max_tokens

            return self.context.llm.complete(
                messages,
                temperature=temperature,
                **kwargs
            )
        except Exception as e:
            self.logger.error(f"Error using LLM: {e}")
            return None

    def schedule_task(
        self,
        func: Any,
        cron_expression: str,
        job_id: Optional[str] = None,
    ) -> Optional[str]:
        """Schedule a recurring task.

        Args:
            func: Function to execute
            cron_expression: Cron expression
            job_id: Optional job ID

        Returns:
            Job ID or None if scheduling failed
        """
        if not self.context.scheduler:
            self.logger.warning("Scheduler not available")
            return None

        try:
            return self.context.scheduler.add_cron_job(
                func,
                cron_expression,
                job_id=job_id,
            )
        except Exception as e:
            self.logger.error(f"Error scheduling task: {e}")
            return None

    def validate_config(self) -> bool:
        """Validate plugin configuration.

        Override to implement custom validation.

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
