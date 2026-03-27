"""Daily digest agent plugin."""

from datetime import datetime, timedelta
from typing import Dict, Any

from pios.sdk import AgentPlugin


class Plugin(AgentPlugin):
    """Agent that creates daily digest of collected data."""

    async def run(self) -> Dict[str, Any]:
        """Execute the daily digest agent.

        Returns:
            Execution result dictionary
        """
        self.logger.info("Starting daily digest generation")

        try:
            # Get configuration
            include_sources = self.context.get_config("include_sources", [])
            max_items = self.context.get_config("max_items_per_source", 5)

            # Query documents from last 24 hours
            yesterday = (datetime.utcnow() - timedelta(days=1)).isoformat()

            docs = self.query_documents(limit=100)
            self.logger.info(f"Found {len(docs)} documents for digest")

            if not docs:
                self.logger.info("No documents to include in digest")
                return {"status": "success", "items_included": 0}

            # Build digest content
            digest_lines = [
                "# Daily Digest",
                f"Generated: {datetime.utcnow().isoformat()}",
                "",
            ]

            # Group by source
            by_source = {}
            for doc in docs:
                source = doc.get("source", "unknown")
                if include_sources and source not in include_sources:
                    continue

                if source not in by_source:
                    by_source[source] = []
                by_source[source].append(doc)

            # Add each source's items
            total_items = 0
            for source, source_docs in by_source.items():
                digest_lines.append(f"## {source}")
                digest_lines.append("")

                for doc in source_docs[:max_items]:
                    digest_lines.append(f"- **{doc.get('title', 'Untitled')}** ({doc.get('type')})")
                    digest_lines.append(f"  - Date: {doc.get('date', 'N/A')}")
                    digest_lines.append("")
                    total_items += 1

            digest_content = "\n".join(digest_lines)

            # Save digest document
            doc_id = self.save_document(
                title=f"Daily Digest - {datetime.utcnow().date()}",
                content=digest_content,
                doc_type="daily-digest",
                tags=["digest", "daily"],
            )

            self.logger.info(f"Created digest document {doc_id} with {total_items} items")

            return {
                "status": "success",
                "items_included": total_items,
                "digest_id": doc_id,
            }

        except Exception as e:
            self.logger.error(f"Error generating digest: {e}")
            return {
                "status": "failed",
                "error": str(e),
            }
