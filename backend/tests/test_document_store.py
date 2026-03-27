"""Tests for document store."""

import pytest
import tempfile
from pathlib import Path

from pios.core.database import Database
from pios.document.store import DocumentStore
from pios.document.models import Document


@pytest.fixture
def db():
    """Create test database."""
    with tempfile.NamedTemporaryFile(suffix='.db') as f:
        db = Database(f.name)
        db.init_schema()
        yield db
        db.disconnect()


@pytest.fixture
def store(db):
    """Create test document store."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = DocumentStore(tmpdir, db)
        yield store


def test_save_document(store, db):
    """Test saving a document."""
    doc_id = store.save(
        source="test",
        data_type="note",
        content={"text": "Test content"},
        title="Test Note",
    )

    assert doc_id is not None

    # Check it was saved
    doc = store.get(doc_id)
    assert doc is not None
    assert doc.title == "Test Note"
    assert doc.content["text"] == "Test content"


def test_document_markdown_roundtrip():
    """Test markdown serialization roundtrip."""
    doc = Document(
        doc_id="test-123",
        source="test",
        data_type="note",
        title="Test Note",
        content={"text": "Test content"},
        tags=["test", "markdown"],
    )

    # Serialize to markdown
    markdown = doc.to_markdown_with_frontmatter()
    assert "---" in markdown
    assert "Test Note" in markdown
    assert "Test content" in markdown

    # Deserialize back
    doc2 = Document.from_markdown_with_frontmatter(markdown)
    assert doc2.title == "Test Note"
    assert doc2.tags == ["test", "markdown"]


def test_list_documents(store):
    """Test listing documents."""
    # Save multiple documents
    store.save(
        source="test",
        data_type="note",
        content={"text": "Note 1"},
        title="Note 1",
    )
    store.save(
        source="test",
        data_type="note",
        content={"text": "Note 2"},
        title="Note 2",
    )

    # List documents
    docs = store.list_documents()
    assert len(docs) >= 2


def test_search_documents(store):
    """Test searching documents."""
    store.save(
        source="test",
        data_type="note",
        content={"text": "This is about Python"},
        title="Python Note",
    )

    store.save(
        source="test",
        data_type="note",
        content={"text": "This is about JavaScript"},
        title="JavaScript Note",
    )

    # Search for Python
    results = store.search("Python")
    assert len(results) >= 1
    assert any("Python" in r.title for r in results)
