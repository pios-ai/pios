"""Integration tests for FastAPI routes."""

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="module")
async def client():
    """Start the FastAPI app with a test client (no real DB/plugins needed)."""
    import sys
    from pathlib import Path
    # Ensure backend is on the path
    sys.path.insert(0, str(Path(__file__).parent.parent))

    # Patch deps so the app boots without a real config file
    import pios.deps as deps
    from pios.core.config import PiOSConfig
    from pios.core.database import Database
    from pios.document.store import DocumentStore
    from pios.core.llm import LLMClient
    from pios.core.scheduler import PiOSScheduler
    from pios.plugin.manager import PluginManager
    import tempfile, os

    tmpdir = tempfile.mkdtemp()
    db_path = os.path.join(tmpdir, "test.db")
    vault_path = os.path.join(tmpdir, "vault")

    deps._config = PiOSConfig(
        database={"path": db_path},
        storage={"vault_path": vault_path},
        plugin_dirs=[tmpdir],
        scheduler={"enabled": False},
    )
    deps._database = Database(db_path)
    deps._database.init_schema()
    deps._document_store = DocumentStore(vault_path, deps._database)
    deps._llm = LLMClient()
    deps._scheduler = PiOSScheduler(enabled=False)
    deps._plugin_manager = PluginManager(
        plugin_dirs=[tmpdir],
        database=deps._database,
        document_store=deps._document_store,
        scheduler=deps._scheduler,
        llm=deps._llm,
    )
    deps._plugin_manager.discover_plugins()

    from pios.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac

    deps._database.disconnect()
    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)


@pytest.mark.anyio
async def test_health(client):
    resp = await client.get("/api/system/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


@pytest.mark.anyio
async def test_system_status(client):
    resp = await client.get("/api/system/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "database" in data
    assert "scheduler" in data
    assert "plugins" in data
    assert "llm" in data


@pytest.mark.anyio
async def test_list_plugins_empty(client):
    resp = await client.get("/api/plugins/")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.anyio
async def test_list_documents_empty(client):
    resp = await client.get("/api/documents/")
    assert resp.status_code == 200
    data = resp.json()
    assert "documents" in data
    assert data["total"] == 0


@pytest.mark.anyio
async def test_document_stats(client):
    resp = await client.get("/api/documents/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "database" in data
    assert "vault" in data


@pytest.mark.anyio
async def test_document_calendar(client):
    resp = await client.get("/api/documents/calendar?year=2026&month=3")
    assert resp.status_code == 200
    data = resp.json()
    assert data["year"] == 2026
    assert data["month"] == 3
    assert "days" in data


@pytest.mark.anyio
async def test_document_roundtrip(client):
    """Save a document via the document store and retrieve it via API."""
    import pios.deps as deps

    doc_id = deps._document_store.save(
        source="test-api",
        data_type="test",
        content={"text": "# Hello\n\nWorld"},
        title="API Test",
        date="2026-01-01",
        tags=["test"],
    )
    assert doc_id

    resp = await client.get(f"/api/documents/{doc_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "API Test"
    assert data["source"] == "test-api"
    assert "Hello" in data["content"]["text"]


@pytest.mark.anyio
async def test_document_list_with_date_filter(client):
    """date_from / date_to filter should narrow results."""
    resp = await client.get("/api/documents/?date_from=2026-01-01&date_to=2026-01-01")
    assert resp.status_code == 200
    data = resp.json()
    # We saved one doc for 2026-01-01 in the previous test
    assert data["total"] >= 1
    for doc in data["documents"]:
        assert doc["date"] == "2026-01-01"


@pytest.mark.anyio
async def test_scheduler_status(client):
    resp = await client.get("/api/scheduler/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "running" in data or "status" in data


@pytest.mark.anyio
async def test_plugin_not_found(client):
    resp = await client.get("/api/plugins/does-not-exist")
    assert resp.status_code == 404
