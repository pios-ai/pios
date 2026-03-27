"""SQLite database setup and management."""

import sqlite3
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)


class Database:
    """SQLite database manager for PiOS."""

    def __init__(self, db_path: str):
        """Initialize database connection.

        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection: Optional[sqlite3.Connection] = None

    def connect(self) -> None:
        """Establish database connection."""
        if self.connection is None:
            self.connection = sqlite3.connect(str(self.db_path))
            self.connection.row_factory = sqlite3.Row
            logger.info(f"Connected to database at {self.db_path}")

    def disconnect(self) -> None:
        """Close database connection."""
        if self.connection:
            self.connection.close()
            self.connection = None
            logger.info("Disconnected from database")

    def __enter__(self):
        """Context manager entry."""
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.disconnect()

    def execute(self, query: str, params: tuple = ()) -> sqlite3.Cursor:
        """Execute a query.

        Args:
            query: SQL query string
            params: Query parameters

        Returns:
            Cursor object
        """
        if self.connection is None:
            self.connect()
        return self.connection.execute(query, params)

    def commit(self) -> None:
        """Commit pending transactions."""
        if self.connection:
            self.connection.commit()

    def rollback(self) -> None:
        """Rollback pending transactions."""
        if self.connection:
            self.connection.rollback()

    def init_schema(self) -> None:
        """Initialize database schema."""
        self.connect()

        # Documents table
        self.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                type TEXT NOT NULL,
                date TEXT,
                title TEXT,
                tags TEXT,
                file_path TEXT NOT NULL UNIQUE,
                content_hash TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )

        # Plugin runs table
        self.execute(
            """
            CREATE TABLE IF NOT EXISTS plugin_runs (
                id TEXT PRIMARY KEY,
                plugin_name TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                documents_created INTEGER DEFAULT 0,
                error_message TEXT,
                duration_ms INTEGER,
                created_at TEXT NOT NULL
            )
            """
        )

        # Plugin state table for persistence
        self.execute(
            """
            CREATE TABLE IF NOT EXISTS plugin_state (
                plugin_name TEXT PRIMARY KEY,
                last_run TEXT,
                last_run_status TEXT,
                state_data TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )

        # Plugin configs table for enable/disable and user config overrides
        self.execute(
            """
            CREATE TABLE IF NOT EXISTS plugin_configs (
                plugin_name TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_overrides TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )

        # Create indices
        self.execute("CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source)")
        self.execute("CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)")
        self.execute("CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(date)")
        self.execute("CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at)")
        self.execute("CREATE INDEX IF NOT EXISTS idx_plugin_runs_name ON plugin_runs(plugin_name)")
        self.execute("CREATE INDEX IF NOT EXISTS idx_plugin_runs_status ON plugin_runs(status)")

        self.commit()
        logger.info("Database schema initialized")

    def insert_document(
        self,
        doc_id: str,
        source: str,
        doc_type: str,
        file_path: str,
        content_hash: str,
        date: Optional[str] = None,
        title: Optional[str] = None,
        tags: Optional[str] = None,
    ) -> None:
        """Insert a document record.

        Args:
            doc_id: Unique document ID
            source: Source plugin name
            doc_type: Document type
            file_path: Path to document file
            content_hash: Hash of document content
            date: Document date
            title: Document title
            tags: Comma-separated tags
        """
        now = datetime.utcnow().isoformat()
        self.execute(
            """
            INSERT INTO documents
            (id, source, type, date, title, tags, file_path, content_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (doc_id, source, doc_type, date, title, tags, file_path, content_hash, now, now),
        )
        self.commit()

    def insert_plugin_run(
        self,
        run_id: str,
        plugin_name: str,
        started_at: str,
        status: str,
        documents_created: int = 0,
        error_message: Optional[str] = None,
        finished_at: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        """Insert a plugin run record.

        Args:
            run_id: Unique run ID
            plugin_name: Name of the plugin
            started_at: ISO timestamp of when run started
            status: Run status (success, failed, running)
            documents_created: Number of documents created
            error_message: Error message if failed
            finished_at: ISO timestamp of when run finished
            duration_ms: Duration in milliseconds
        """
        now = datetime.utcnow().isoformat()
        self.execute(
            """
            INSERT INTO plugin_runs
            (id, plugin_name, started_at, finished_at, status, documents_created, error_message, duration_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                plugin_name,
                started_at,
                finished_at,
                status,
                documents_created,
                error_message,
                duration_ms,
                now,
            ),
        )
        self.commit()

    def get_documents(
        self,
        source: Optional[str] = None,
        doc_type: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        tags: Optional[List[str]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Retrieve documents with optional filtering.

        Args:
            source: Filter by source plugin
            doc_type: Filter by document type
            date_from: Filter by date >= (ISO format YYYY-MM-DD)
            date_to: Filter by date <= (ISO format YYYY-MM-DD)
            tags: Filter by tags (any match)
            limit: Maximum results to return
            offset: Offset for pagination

        Returns:
            List of document records
        """
        query = "SELECT * FROM documents WHERE 1=1"
        params = []

        if source:
            query += " AND source = ?"
            params.append(source)
        if doc_type:
            query += " AND type = ?"
            params.append(doc_type)
        if date_from:
            query += " AND date >= ?"
            params.append(date_from)
        if date_to:
            query += " AND date <= ?"
            params.append(date_to)
        if tags:
            tag_conditions = " OR ".join(["tags LIKE ?" for _ in tags])
            query += f" AND ({tag_conditions})"
            params.extend([f"%{tag}%" for tag in tags])

        query += " ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        cursor = self.execute(query, tuple(params))
        return [dict(row) for row in cursor.fetchall()]

    def get_plugin_config(self, plugin_name: str) -> Optional[Dict[str, Any]]:
        """Get plugin config (enabled state + overrides).

        Args:
            plugin_name: Name of the plugin

        Returns:
            Plugin config dict or None
        """
        cursor = self.execute(
            "SELECT * FROM plugin_configs WHERE plugin_name = ?",
            (plugin_name,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None

    def set_plugin_enabled(self, plugin_name: str, enabled: bool) -> None:
        """Enable or disable a plugin.

        Args:
            plugin_name: Name of the plugin
            enabled: Whether the plugin should be enabled
        """
        now = datetime.utcnow().isoformat()
        self.execute(
            """
            INSERT INTO plugin_configs (plugin_name, enabled, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(plugin_name) DO UPDATE SET enabled = ?, updated_at = ?
            """,
            (plugin_name, int(enabled), now, int(enabled), now),
        )
        self.commit()

    def set_plugin_config_overrides(self, plugin_name: str, config_json: str) -> None:
        """Store user config overrides for a plugin.

        Args:
            plugin_name: Name of the plugin
            config_json: JSON-encoded config overrides
        """
        now = datetime.utcnow().isoformat()
        self.execute(
            """
            INSERT INTO plugin_configs (plugin_name, enabled, config_overrides, updated_at)
            VALUES (?, 1, ?, ?)
            ON CONFLICT(plugin_name) DO UPDATE SET config_overrides = ?, updated_at = ?
            """,
            (plugin_name, config_json, now, config_json, now),
        )
        self.commit()

    def get_plugin_runs(
        self,
        plugin_name: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Retrieve plugin run history.

        Args:
            plugin_name: Filter by plugin name
            limit: Maximum results to return

        Returns:
            List of plugin run records
        """
        query = "SELECT * FROM plugin_runs WHERE 1=1"
        params = []

        if plugin_name:
            query += " AND plugin_name = ?"
            params.append(plugin_name)

        query += " ORDER BY started_at DESC LIMIT ?"
        params.append(limit)

        cursor = self.execute(query, tuple(params))
        return [dict(row) for row in cursor.fetchall()]

    def get_plugin_state(self, plugin_name: str) -> Optional[Dict[str, Any]]:
        """Get persisted state for a plugin.

        Args:
            plugin_name: Name of the plugin

        Returns:
            Plugin state dict or None if not found
        """
        cursor = self.execute(
            "SELECT * FROM plugin_state WHERE plugin_name = ?",
            (plugin_name,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None

    def set_plugin_state(self, plugin_name: str, state_data: str) -> None:
        """Set persisted state for a plugin.

        Args:
            plugin_name: Name of the plugin
            state_data: JSON-encoded state data
        """
        now = datetime.utcnow().isoformat()
        self.execute(
            """
            INSERT INTO plugin_state (plugin_name, state_data, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(plugin_name) DO UPDATE SET state_data = ?, updated_at = ?
            """,
            (plugin_name, state_data, now, state_data, now),
        )
        self.commit()

    def document_exists(self, file_path: str) -> bool:
        """Check if a document already exists.

        Args:
            file_path: Path to document file

        Returns:
            True if document exists
        """
        cursor = self.execute(
            "SELECT 1 FROM documents WHERE file_path = ?",
            (file_path,),
        )
        return cursor.fetchone() is not None

    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics.

        Returns:
            Dictionary with various stats
        """
        cursor = self.execute("SELECT COUNT(*) as count FROM documents")
        doc_count = cursor.fetchone()["count"]

        cursor = self.execute("SELECT COUNT(*) as count FROM plugin_runs")
        run_count = cursor.fetchone()["count"]

        cursor = self.execute("SELECT COUNT(DISTINCT source) as count FROM documents")
        source_count = cursor.fetchone()["count"]

        return {
            "total_documents": doc_count,
            "total_plugin_runs": run_count,
            "total_sources": source_count,
        }
