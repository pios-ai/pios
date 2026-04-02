"""Tests for plugin manager."""

import pytest
import tempfile
import yaml
from pathlib import Path

from pios.core.database import Database
from pios.core.scheduler import PiOSScheduler
from pios.document.store import DocumentStore
from pios.core.llm import LLMClient
from pios.plugin.manager import PluginManager


@pytest.fixture
def plugin_manager():
    """Create test plugin manager."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create test database
        db_path = Path(tmpdir) / "test.db"
        db = Database(str(db_path))
        db.init_schema()

        # Create test document store
        vault_path = Path(tmpdir) / "vault"
        doc_store = DocumentStore(str(vault_path), db)

        # Create scheduler
        scheduler = PiOSScheduler()

        # Create LLM
        llm = LLMClient()

        # Create plugin manager
        manager = PluginManager(
            plugin_dirs=[tmpdir],
            database=db,
            document_store=doc_store,
            scheduler=scheduler,
            llm=llm,
        )

        yield manager

        db.disconnect()


def test_plugin_discovery(plugin_manager):
    """Test plugin discovery."""
    # The test should find 0 plugins initially
    plugins = plugin_manager.discover_plugins()
    assert isinstance(plugins, list)


def test_load_plugin_manifest(plugin_manager):
    """Test loading plugin manifest."""
    # Create a test plugin
    with tempfile.TemporaryDirectory() as tmpdir:
        plugin_dir = Path(tmpdir) / "test-plugin"
        plugin_dir.mkdir()

        # Create manifest
        manifest = {
            "name": "test-plugin",
            "version": "0.1.0",
            "type": "source",
            "description": "Test plugin",
        }

        with open(plugin_dir / "plugin.yaml", "w") as f:
            yaml.dump(manifest, f)

        # Update plugin dirs
        plugin_manager.plugin_dirs = [Path(tmpdir)]

        # Discover
        plugins = plugin_manager.discover_plugins()
        assert "test-plugin" in plugins


def test_plugin_status(plugin_manager):
    """Test getting plugin status."""
    # Status of non-existent plugin should be None
    status = plugin_manager.get_plugin_status("non-existent")
    assert status is None
