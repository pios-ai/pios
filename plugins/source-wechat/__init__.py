"""WeChat data source plugin."""

from datetime import datetime
from typing import List, Dict, Any

from pios.sdk import SourcePlugin, SourceData


class Plugin(SourcePlugin):
    """WeChat source plugin."""

    def fetch(self) -> List[SourceData]:
        """Fetch data from WeChat.

        Returns:
            List of SourceData objects
        """
        self.logger.info("Fetching data from WeChat")

        data = []

        # Get configuration
        api_key = self.context.get_config("wechat_api_key")
        sync_messages = self.context.get_config("sync_messages", True)
        sync_moments = self.context.get_config("sync_moments", True)

        if not api_key:
            self.logger.warning("WeChat API key not configured")
            return data

        try:
            now = datetime.utcnow().isoformat()

            if sync_messages:
                # Simulate fetching messages
                data.append(
                    SourceData(
                        source="wechat",
                        data_type="message",
                        content={
                            "from": "Friend Name",
                            "text": "Hello! How are you?",
                            "timestamp": now,
                        },
                        title="WeChat Message from Friend Name",
                        date=now.split("T")[0],
                        tags=["wechat", "message"],
                    )
                )

            if sync_moments:
                # Simulate fetching moments
                data.append(
                    SourceData(
                        source="wechat",
                        data_type="moment",
                        content={
                            "author": "Friend Name",
                            "text": "Just had a great lunch!",
                            "image_urls": ["https://example.com/image.jpg"],
                            "timestamp": now,
                        },
                        title="WeChat Moment from Friend Name",
                        date=now.split("T")[0],
                        tags=["wechat", "moment"],
                    )
                )

            self.logger.info(f"Fetched {len(data)} WeChat items")

        except Exception as e:
            self.logger.error(f"Error fetching WeChat data: {e}")

        return data

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        """Normalize WeChat data.

        Args:
            data: Raw SourceData

        Returns:
            Normalized data dictionary
        """
        return {
            "type": data.data_type,
            "content": data.content,
            "timestamp": data.content.get("timestamp"),
        }

    def validate_config(self) -> bool:
        """Validate configuration.

        Returns:
            True if config is valid
        """
        api_key = self.context.get_config("wechat_api_key")
        if not api_key:
            self.logger.warning("WeChat API key is required")
            return False
        return True
