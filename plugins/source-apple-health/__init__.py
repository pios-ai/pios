"""Apple Health data source plugin."""

from datetime import datetime, timedelta
from typing import List, Dict, Any

from pios.sdk import SourcePlugin, SourceData


class Plugin(SourcePlugin):
    """Apple Health source plugin."""

    def fetch(self) -> List[SourceData]:
        """Fetch data from Apple Health.

        Returns:
            List of SourceData objects
        """
        self.logger.info("Fetching data from Apple Health")

        data = []

        # Get configuration
        health_token = self.context.get_config("health_kit_token")
        sync_days = self.context.get_config("sync_days", 7)

        if not health_token:
            self.logger.warning("Apple Health token not configured")
            return data

        try:
            # Simulate fetching health data
            # In production, would use Apple HealthKit API
            now = datetime.utcnow()

            for i in range(sync_days):
                date = now - timedelta(days=i)
                date_str = date.date().isoformat()

                # Create sample data points
                data.append(
                    SourceData(
                        source="apple-health",
                        data_type="health-summary",
                        content={
                            "date": date_str,
                            "steps": 8000 + i * 100,
                            "heart_rate": 72,
                            "distance": 5.2,
                            "active_calories": 300,
                        },
                        title=f"Health Summary - {date_str}",
                        date=date_str,
                        tags=["health", "daily"],
                    )
                )

            self.logger.info(f"Fetched {len(data)} health records")

        except Exception as e:
            self.logger.error(f"Error fetching Apple Health data: {e}")

        return data

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        """Normalize Apple Health data.

        Args:
            data: Raw SourceData

        Returns:
            Normalized data dictionary
        """
        return {
            "date": data.content.get("date"),
            "steps": data.content.get("steps"),
            "heart_rate": data.content.get("heart_rate"),
            "distance_km": data.content.get("distance"),
            "calories": data.content.get("active_calories"),
        }

    def validate_config(self) -> bool:
        """Validate configuration.

        Returns:
            True if config is valid
        """
        token = self.context.get_config("health_kit_token")
        if not token:
            self.logger.warning("Apple Health token is required")
            return False
        return True
