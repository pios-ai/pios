"""Tests for configuration module."""

import pytest
import tempfile
import os
from pathlib import Path

from pios.core.config import PiOSConfig, LLMConfig


def test_config_defaults():
    """Test default configuration."""
    config = PiOSConfig()

    assert config.app_name == "PiOS"
    assert config.debug is False
    assert config.llm.provider == "openai"
    assert config.database.type == "sqlite"


def test_config_env_interpolation():
    """Test environment variable interpolation."""
    os.environ["TEST_API_KEY"] = "test-key-123"

    config = PiOSConfig(
        llm=LLMConfig(api_key="${TEST_API_KEY}")
    )

    assert config.llm.api_key == "test-key-123"


def test_config_from_yaml():
    """Test loading config from YAML file."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
        f.write("""
app_name: TestPiOS
debug: true
llm:
  provider: anthropic
  model: claude-3
database:
  type: sqlite
  path: /tmp/test.db
""")
        config_path = f.name

    try:
        config = PiOSConfig.from_file(config_path)

        assert config.app_name == "TestPiOS"
        assert config.debug is True
        assert config.llm.provider == "anthropic"

    finally:
        os.unlink(config_path)


def test_config_create_default():
    """Test creating default config file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = Path(tmpdir) / "config.yaml"

        PiOSConfig.create_default(str(config_path))

        assert config_path.exists()

        # Load it back
        config = PiOSConfig.from_file(str(config_path))
        assert config.app_name == "PiOS"


def test_config_ensure_directories():
    """Test directory creation."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = PiOSConfig(
            storage={"vault_path": str(Path(tmpdir) / "vault")},
            database={"path": str(Path(tmpdir) / "db" / "test.db")},
        )

        config.ensure_directories()

        assert Path(config.storage.vault_path).exists()
        assert Path(config.database.path).parent.exists()
