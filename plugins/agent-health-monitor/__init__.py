"""Health monitoring agent plugin."""

from datetime import datetime, timedelta
from typing import Dict, Any, List

from pios.sdk import AgentPlugin


class Plugin(AgentPlugin):
    """Agent that monitors health metrics and generates alerts."""

    async def run(self) -> Dict[str, Any]:
        """Execute the health monitoring agent.

        Returns:
            Execution result dictionary
        """
        self.logger.info("Starting health monitoring")

        try:
            # Get configuration
            steps_threshold = self.context.get_config("alert_threshold_steps", 5000)
            sleep_threshold = self.context.get_config("alert_threshold_sleep", 6)

            # Query health documents from Apple Health
            health_docs = self.query_documents(
                source="apple-health",
                doc_type="health-summary",
                limit=30,
            )

            if not health_docs:
                self.logger.info("No health documents found")
                return {"status": "success", "alerts": 0}

            # Analyze health metrics
            alerts = self._generate_alerts(
                health_docs,
                steps_threshold,
                sleep_threshold,
            )

            self.logger.info(f"Generated {len(alerts)} health alerts")

            # Save analysis document if there are alerts
            if alerts:
                analysis_content = self._format_alerts(alerts)
                doc_id = self.save_document(
                    title=f"Health Analysis - {datetime.utcnow().date()}",
                    content=analysis_content,
                    doc_type="health-analysis",
                    tags=["health", "alert", "monitoring"],
                )
                self.logger.info(f"Created analysis document {doc_id}")

            return {
                "status": "success",
                "alerts": len(alerts),
                "alert_details": alerts,
            }

        except Exception as e:
            self.logger.error(f"Error in health monitoring: {e}")
            return {
                "status": "failed",
                "error": str(e),
            }

    def _generate_alerts(
        self,
        health_docs: List[Dict[str, Any]],
        steps_threshold: int,
        sleep_threshold: int,
    ) -> List[Dict[str, Any]]:
        """Generate alerts based on health metrics.

        Args:
            health_docs: List of health documents
            steps_threshold: Minimum daily steps
            sleep_threshold: Minimum daily sleep hours

        Returns:
            List of alert dictionaries
        """
        alerts = []

        for doc in health_docs[:7]:  # Last 7 days
            # Check steps (simulated)
            steps = 6000  # Would be extracted from doc in real implementation

            if steps < steps_threshold:
                alerts.append({
                    "type": "low_steps",
                    "date": doc.get("date"),
                    "value": steps,
                    "threshold": steps_threshold,
                    "message": f"Low activity: {steps} steps (target: {steps_threshold})",
                })

        return alerts

    def _format_alerts(self, alerts: List[Dict[str, Any]]) -> str:
        """Format alerts as readable content.

        Args:
            alerts: List of alerts

        Returns:
            Formatted alert content
        """
        lines = [
            "# Health Alerts",
            f"Generated: {datetime.utcnow().isoformat()}",
            f"Total Alerts: {len(alerts)}",
            "",
        ]

        for alert in alerts:
            lines.append(f"## {alert['type'].replace('_', ' ').title()}")
            lines.append(f"- Date: {alert.get('date')}")
            lines.append(f"- Current: {alert.get('value')}")
            lines.append(f"- Target: {alert.get('threshold')}")
            lines.append(f"- Message: {alert.get('message')}")
            lines.append("")

        return "\n".join(lines)
