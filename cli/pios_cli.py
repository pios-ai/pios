"""Command-line interface for PiOS."""

import typer
import json
from pathlib import Path
from typing import Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

app = typer.Typer(help="PiOS - Personal Intelligence OS CLI")
console = Console()


@app.command()
def init(
    config_path: Optional[str] = typer.Option(
        None,
        "--config",
        "-c",
        help="Path to config file"
    ),
):
    """Initialize PiOS configuration."""
    from pios.core.config import PiOSConfig

    config_file = Path(config_path) if config_path else Path.home() / ".pios" / "config.yaml"

    if config_file.exists():
        console.print(f"[yellow]Config already exists at {config_file}[/yellow]")
        return

    PiOSConfig.create_default(str(config_file))
    console.print(f"[green]Created config at {config_file}[/green]")


@app.command()
def config_show(
    config_path: Optional[str] = typer.Option(
        None,
        "--config",
        "-c",
        help="Path to config file"
    ),
):
    """Show current configuration."""
    from pios.core.config import PiOSConfig

    config = PiOSConfig.from_file(config_path)

    panel = Panel(
        f"""
App Name: {config.app_name}
Debug: {config.debug}
Log Level: {config.log_level}

LLM Provider: {config.llm.provider}
LLM Model: {config.llm.model}

Database: {config.database.type}
Database Path: {config.database.path}

Scheduler Enabled: {config.scheduler.enabled}
Scheduler Timezone: {config.scheduler.timezone}

Storage Path: {config.storage.vault_path}
        """,
        title="PiOS Configuration",
    )
    console.print(panel)


@app.command()
def plugins_list(
    config_path: Optional[str] = typer.Option(
        None,
        "--config",
        "-c",
        help="Path to config file"
    ),
):
    """List all discovered plugins."""
    from pios.core.config import PiOSConfig
    from pios.core.database import Database
    from pios.document.store import DocumentStore
    from pios.core.scheduler import PiOSScheduler
    from pios.core.llm import LLMClient
    from pios.plugin.manager import PluginManager

    config = PiOSConfig.from_file(config_path)
    config.ensure_directories()

    db = Database(config.database.path)
    db.init_schema()

    doc_store = DocumentStore(config.storage.vault_path, db)
    scheduler = PiOSScheduler()
    llm = LLMClient()

    manager = PluginManager(
        plugin_dirs=config.plugin_dirs,
        database=db,
        document_store=doc_store,
        scheduler=scheduler,
        llm=llm,
    )

    plugins = manager.discover_plugins()

    if not plugins:
        console.print("[yellow]No plugins found[/yellow]")
        return

    table = Table(title="Available Plugins")
    table.add_column("Name", style="cyan")
    table.add_column("Version", style="magenta")
    table.add_column("Type", style="green")
    table.add_column("Description", style="white")

    for plugin_name in plugins:
        manifest = manager.manifests.get(plugin_name)
        if manifest:
            table.add_row(
                manifest.name,
                manifest.version,
                manifest.type,
                manifest.description[:50],
            )

    console.print(table)
    db.disconnect()


@app.command()
def run(
    plugin_name: str = typer.Argument(..., help="Name of plugin to run"),
    config_path: Optional[str] = typer.Option(
        None,
        "--config",
        "-c",
        help="Path to config file"
    ),
):
    """Run a plugin."""
    import asyncio
    from pios.core.config import PiOSConfig
    from pios.core.database import Database
    from pios.document.store import DocumentStore
    from pios.core.scheduler import PiOSScheduler
    from pios.core.llm import LLMClient
    from pios.plugin.manager import PluginManager

    config = PiOSConfig.from_file(config_path)
    config.ensure_directories()

    db = Database(config.database.path)
    db.init_schema()

    doc_store = DocumentStore(config.storage.vault_path, db)
    scheduler = PiOSScheduler()
    llm = LLMClient()

    manager = PluginManager(
        plugin_dirs=config.plugin_dirs,
        database=db,
        document_store=doc_store,
        scheduler=scheduler,
        llm=llm,
    )

    manager.discover_plugins()

    with console.status(f"[bold green]Running {plugin_name}..."):
        result = asyncio.run(manager.run_plugin(plugin_name))

    if result["status"] == "success":
        console.print(f"[green]✓ Plugin completed successfully[/green]")
        console.print(json.dumps(result, indent=2))
    else:
        console.print(f"[red]✗ Plugin failed: {result.get('error')}[/red]")

    db.disconnect()


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", "--host", "-h"),
    port: int = typer.Option(8000, "--port", "-p"),
    config_path: Optional[str] = typer.Option(
        None,
        "--config",
        "-c",
        help="Path to config file"
    ),
):
    """Start PiOS API server."""
    import uvicorn
    from pios.main import app as pios_app

    console.print(
        f"[green]Starting PiOS API on {host}:{port}[/green]"
    )
    console.print("[yellow]Press Ctrl+C to stop[/yellow]")

    uvicorn.run(pios_app, host=host, port=port)


@app.command()
def version():
    """Show PiOS version."""
    from pios import __version__

    console.print(f"[bold]PiOS[/bold] v{__version__}")


if __name__ == "__main__":
    app()
