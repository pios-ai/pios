"""Document vault manager with file storage and SQLite indexing."""

import logging
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, List

from .models import Document

logger = logging.getLogger(__name__)


class DocumentStore:
    """Manages document storage in vault with SQLite indexing."""

    def __init__(self, vault_path: str, database):
        """Initialize document store.

        Args:
            vault_path: Path to document vault
            database: Database instance for indexing
        """
        self.vault_path = Path(vault_path)
        self.database = database
        self.vault_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"Document store initialized at {self.vault_path}")

    def save(
        self,
        source: str,
        data_type: str,
        content: Dict[str, Any],
        title: Optional[str] = None,
        date: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> str:
        """Save a document to vault.

        Args:
            source: Source plugin name
            data_type: Type of document
            content: Document content (dict)
            title: Document title
            date: Document date
            tags: List of tags

        Returns:
            Document ID
        """
        # Generate ID and paths
        doc_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        # Create document
        doc = Document(
            doc_id=doc_id,
            source=source,
            data_type=data_type,
            content=content,
            title=title,
            date=date,
            tags=tags or [],
            created_at=now,
            updated_at=now,
        )

        # Compute content hash
        doc.content_hash = doc.compute_hash()

        # Create nested directory structure by source/type/year/month
        if date:
            from datetime import datetime as dt
            try:
                parsed_date = dt.fromisoformat(date)
                year = parsed_date.year
                month = parsed_date.month
            except (ValueError, AttributeError):
                year = "unknown"
                month = "unknown"
        else:
            year = "unknown"
            month = "unknown"

        doc_dir = self.vault_path / source / data_type / str(year) / f"{month:02d}"
        doc_dir.mkdir(parents=True, exist_ok=True)

        # Save as markdown file
        file_path = doc_dir / f"{doc_id}.md"
        markdown = doc.to_markdown_with_frontmatter()

        with open(file_path, "w") as f:
            f.write(markdown)

        doc.file_path = str(file_path)

        # Index in database
        self.database.insert_document(
            doc_id=doc_id,
            source=source,
            doc_type=data_type,
            file_path=str(file_path),
            content_hash=doc.content_hash,
            date=date,
            title=title,
            tags=",".join(tags) if tags else None,
        )

        logger.info(f"Saved document {doc_id} to {file_path}")

        return doc_id

    def get(self, doc_id: str) -> Optional[Document]:
        """Retrieve a document by ID.

        Args:
            doc_id: Document ID

        Returns:
            Document object or None if not found
        """
        # Search for markdown file
        for md_file in self.vault_path.rglob(f"{doc_id}.md"):
            with open(md_file, "r") as f:
                markdown = f.read()
            return Document.from_markdown_with_frontmatter(markdown)

        logger.warning(f"Document {doc_id} not found")
        return None

    def list_documents(
        self,
        source: Optional[str] = None,
        data_type: Optional[str] = None,
        limit: int = 100,
    ) -> List[Document]:
        """List documents from vault.

        Args:
            source: Filter by source
            data_type: Filter by type
            limit: Maximum results

        Returns:
            List of documents
        """
        documents = []

        # Get from database
        db_results = self.database.get_documents(
            source=source,
            doc_type=data_type,
            limit=limit,
        )

        for row in db_results:
            file_path = row["file_path"]
            if Path(file_path).exists():
                with open(file_path, "r") as f:
                    markdown = f.read()
                try:
                    doc = Document.from_markdown_with_frontmatter(markdown)
                    documents.append(doc)
                except Exception as e:
                    logger.error(f"Error parsing {file_path}: {e}")

        return documents

    def search(self, query: str, limit: int = 50) -> List[Document]:
        """Search documents by content.

        Args:
            query: Search query
            limit: Maximum results

        Returns:
            List of matching documents
        """
        matching_docs = []
        query_lower = query.lower()

        # Search markdown files
        for md_file in self.vault_path.rglob("*.md"):
            try:
                with open(md_file, "r") as f:
                    content = f.read()

                if query_lower in content.lower():
                    doc = Document.from_markdown_with_frontmatter(content)
                    matching_docs.append(doc)

                    if len(matching_docs) >= limit:
                        break
            except Exception as e:
                logger.error(f"Error searching {md_file}: {e}")

        return matching_docs

    def delete(self, doc_id: str) -> bool:
        """Delete a document.

        Args:
            doc_id: Document ID

        Returns:
            True if deleted successfully
        """
        # Find and delete file
        for md_file in self.vault_path.rglob(f"{doc_id}.md"):
            try:
                md_file.unlink()
                logger.info(f"Deleted document file {md_file}")
                return True
            except Exception as e:
                logger.error(f"Error deleting {md_file}: {e}")
                return False

        logger.warning(f"Document file for {doc_id} not found")
        return False

    def get_stats(self) -> Dict[str, Any]:
        """Get vault statistics.

        Returns:
            Dictionary with stats
        """
        total_files = len(list(self.vault_path.rglob("*.md")))
        sources = set()
        types = set()

        for md_file in self.vault_path.rglob("*.md"):
            parts = md_file.relative_to(self.vault_path).parts
            if len(parts) >= 2:
                sources.add(parts[0])
                types.add(parts[1])

        return {
            "total_documents": total_files,
            "sources": len(sources),
            "types": len(types),
            "vault_path": str(self.vault_path),
        }
