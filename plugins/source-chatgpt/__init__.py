"""ChatGPT/OpenAI conversations source plugin."""

from datetime import datetime
from typing import List, Dict, Any

from pios.sdk import SourcePlugin, SourceData


class Plugin(SourcePlugin):
    """ChatGPT source plugin for conversation archival."""

    def fetch(self) -> List[SourceData]:
        """Fetch data from ChatGPT.

        Returns:
            List of SourceData objects
        """
        self.logger.info("Fetching data from ChatGPT")

        data = []

        # Get configuration
        api_key = self.context.get_config("openai_api_key")

        if not api_key:
            self.logger.warning("OpenAI API key not configured")
            return data

        try:
            now = datetime.utcnow().isoformat()

            # Simulate fetching conversations
            data.append(
                SourceData(
                    source="chatgpt",
                    data_type="conversation",
                    content={
                        "conversation_id": "conv-001",
                        "title": "Python best practices",
                        "messages": [
                            {
                                "role": "user",
                                "content": "What are Python best practices?",
                            },
                            {
                                "role": "assistant",
                                "content": "Python best practices include...",
                            },
                        ],
                    },
                    title="Conversation: Python best practices",
                    date=now.split("T")[0],
                    tags=["chatgpt", "conversation", "python"],
                )
            )

            self.logger.info(f"Fetched {len(data)} conversations from ChatGPT")

        except Exception as e:
            self.logger.error(f"Error fetching ChatGPT data: {e}")

        return data

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        """Normalize ChatGPT data.

        Args:
            data: Raw SourceData

        Returns:
            Normalized data dictionary
        """
        return {
            "conversation_id": data.content.get("conversation_id"),
            "title": data.content.get("title"),
            "message_count": len(data.content.get("messages", [])),
            "summary": self._summarize_messages(data.content.get("messages", [])),
        }

    def _summarize_messages(self, messages: List[Dict[str, str]]) -> str:
        """Create a summary of conversation messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Summary string
        """
        if not messages:
            return ""

        user_messages = [m["content"] for m in messages if m.get("role") == "user"]
        return " ".join(user_messages[:100])

    def validate_config(self) -> bool:
        """Validate configuration.

        Returns:
            True if config is valid
        """
        api_key = self.context.get_config("openai_api_key")
        if not api_key:
            self.logger.warning("OpenAI API key is required")
            return False
        return True
