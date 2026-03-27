"""Immich photo library source plugin."""

from datetime import datetime
from typing import List, Dict, Any

from pios.sdk import SourcePlugin, SourceData


class Plugin(SourcePlugin):
    """Immich source plugin for photos and videos."""

    def fetch(self) -> List[SourceData]:
        """Fetch data from Immich.

        Returns:
            List of SourceData objects
        """
        self.logger.info("Fetching data from Immich")

        data = []

        # Get configuration
        api_url = self.context.get_config("immich_api_url")
        api_key = self.context.get_config("immich_api_key")

        if not api_url or not api_key:
            self.logger.warning("Immich configuration incomplete")
            return data

        try:
            now = datetime.utcnow().isoformat()

            # Simulate fetching photos
            data.append(
                SourceData(
                    source="immich",
                    data_type="photo",
                    content={
                        "asset_id": "photo-001",
                        "filename": "vacation-2024.jpg",
                        "taken_at": "2024-06-15T14:30:00Z",
                        "latitude": 40.7128,
                        "longitude": -74.0060,
                        "tags": ["vacation", "beach"],
                    },
                    title="Photo: Vacation Beach",
                    date="2024-06-15",
                    tags=["immich", "photo", "vacation"],
                )
            )

            self.logger.info(f"Fetched {len(data)} assets from Immich")

        except Exception as e:
            self.logger.error(f"Error fetching Immich data: {e}")

        return data

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        """Normalize Immich data.

        Args:
            data: Raw SourceData

        Returns:
            Normalized data dictionary
        """
        return {
            "asset_id": data.content.get("asset_id"),
            "filename": data.content.get("filename"),
            "taken_at": data.content.get("taken_at"),
            "location": {
                "latitude": data.content.get("latitude"),
                "longitude": data.content.get("longitude"),
            },
        }

    def validate_config(self) -> bool:
        """Validate configuration.

        Returns:
            True if config is valid
        """
        api_url = self.context.get_config("immich_api_url")
        api_key = self.context.get_config("immich_api_key")

        if not api_url or not api_key:
            self.logger.warning("Immich API URL and key are required")
            return False

        return True
