"""Command-line interface for PiOS."""

import json
import shutil
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

app = typer.Typer(
    help="PiOS — Personal Intelligence OS CLI",
    add_completion=True,   # enables `pios --install-completion`
)
plugin_app = typer.Typer(help="Manage plugins")
docs_app = typer.Typer(help="Browse the document vault")
app.add_typer(plugin_app, name="plugin")
app.add_typer(docs_app, name="docs")

console = Console()

# ── Shared helpers ─────────────────────────────────────────────────────────────

def _build_manager(config_path: Optional[str] = None):
    """Bootstrap a PluginManager from config (used by offline CLI commands)."""
    from pios.core.config import PiOSConfig
    from pios.core.database import Database
    from pios.document.store import DocumentStore
    from pios.core.llm import LLMClient
    from pios.core.scheduler import PiOSScheduler
    from pios.plugin.manager import PluginManager

    config = PiOSConfig.from_file(config_path)
    config.ensure_directories()
    db = Database(config.database.path)
    db.init_schema()
    doc_store = DocumentStore(config.storage.vault_path, db)
    scheduler = PiOSScheduler(enabled=False)
    llm = LLMClient(
        provider=config.llm.provider,
        model=config.llm.model,
        api_key=config.llm.api_key,
    )
    manager = PluginManager(
        plugin_dirs=config.plugin_dirs,
        database=db,
        document_store=doc_store,
        scheduler=scheduler,
        llm=llm,
        plugin_configs=config.plugin_configs,
    )
    manager.discover_plugins()
    return manager, db, config


def _api(method: str, path: str, port: int = 9100, body=None):
    """Make a request to a running PiOS server."""
    import urllib.request, urllib.error
    url = f"http://localhost:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method.upper(),
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except urllib.error.URLError as e:
        return None


# ── Top-level commands ─────────────────────────────────────────────────────────

@app.command()
def init(
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Initialise PiOS configuration at ~/.pios/config.yaml."""
    from pios.core.config import PiOSConfig

    target = Path(config_path) if config_path else Path.home() / ".pios" / "config.yaml"
    if target.exists():
        console.print(f"[yellow]Config already exists: {target}[/yellow]")
        console.print("Edit it directly or delete it to re-initialise.")
        return
    PiOSConfig.create_default(str(target))
    console.print(f"[green]✓ Created config at {target}[/green]")
    console.print("\nNext steps:")
    console.print("  1. Edit the config and set your LLM API key")
    console.print("  2. Run [bold]pios serve[/bold] to start the server")


@app.command()
def config_show(
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Show current configuration."""
    from pios.core.config import PiOSConfig

    config = PiOSConfig.from_file(config_path)
    console.print(Panel(
        f"[bold]App[/bold]       {config.app_name}  (debug={config.debug})\n"
        f"[bold]LLM[/bold]       {config.llm.provider} / {config.llm.model}\n"
        f"[bold]Database[/bold]  {config.database.type}  →  {config.database.path}\n"
        f"[bold]Vault[/bold]     {config.storage.vault_path}\n"
        f"[bold]Scheduler[/bold] enabled={config.scheduler.enabled}  tz={config.scheduler.timezone}\n"
        f"[bold]Plugins[/bold]   {', '.join(config.plugin_dirs)}",
        title="PiOS Configuration",
        border_style="blue",
    ))


@app.command()
def status(
    port: int = typer.Option(9100, "--port", "-p", help="Server port"),
):
    """Check if the PiOS server is running."""
    data = _api("GET", "/api/system/status", port=port)
    if data is None:
        console.print(f"[red]✗ PiOS is not running on port {port}[/red]")
        raise typer.Exit(code=1)

    db_ok = data.get("database", {}).get("status") == "connected"
    sched = data.get("scheduler", {}).get("status", "unknown")
    plugins = data.get("plugins", {}).get("loaded", 0)
    llm = data.get("llm", {})

    console.print(Panel(
        f"[green]✓ PiOS running on port {port}[/green]\n\n"
        f"[bold]Database[/bold]   {'[green]connected[/green]' if db_ok else '[red]error[/red]'}\n"
        f"[bold]Scheduler[/bold]  {sched}\n"
        f"[bold]Plugins[/bold]    {plugins} loaded\n"
        f"[bold]LLM[/bold]        {llm.get('provider','?')} / {llm.get('model','?')} "
        f"({'[green]ok[/green]' if llm.get('available') else '[yellow]no key[/yellow]'})",
        title="PiOS Status",
        border_style="green",
    ))


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", "--host", "-H"),
    port: int = typer.Option(9100, "--port", "-p"),
    reload: bool = typer.Option(False, "--reload", help="Hot-reload (dev mode)"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Start the PiOS API + UI server."""
    import uvicorn

    console.print(f"[green]Starting PiOS on http://{host}:{port}[/green]")
    console.print("[dim]Press Ctrl+C to stop[/dim]")

    uvicorn.run(
        "pios.main:app",
        host=host,
        port=port,
        reload=reload,
        app_dir=str(Path(__file__).parent.parent / "backend"),
    )


@app.command()
def run(
    plugin_name: str = typer.Argument(..., help="Plugin name to execute"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
    port: int = typer.Option(9100, "--port", "-p", help="Use running server (0 = run directly)"),
):
    """Run a plugin immediately (via API if server is running, else directly)."""
    import asyncio

    # Try via running server first
    if port:
        data = _api("POST", f"/api/plugins/{plugin_name}/run", port=port)
        if data is not None:
            console.print(f"[green]✓ Triggered {plugin_name} on server (run_id={data.get('run_id','?')})[/green]")
            return

    # Fall back to running directly (offline mode)
    console.print(f"[yellow]Server not reachable — running {plugin_name} directly...[/yellow]")
    manager, db, _ = _build_manager(config_path)

    with console.status(f"[bold green]Running {plugin_name}..."):
        result = asyncio.run(manager.run_plugin(plugin_name))

    if result.get("status") == "success":
        console.print(f"[green]✓ {plugin_name} completed successfully[/green]")
    else:
        console.print(f"[red]✗ {plugin_name} failed: {result.get('error')}[/red]")
    console.print(json.dumps(result, indent=2, default=str))
    db.disconnect()


@app.command()
def version():
    """Show PiOS version."""
    from pios import __version__
    console.print(f"[bold]PiOS[/bold] v{__version__}")


# ── pios plugin … ──────────────────────────────────────────────────────────────

@plugin_app.command("list")
def plugin_list(
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
    port: int = typer.Option(9100, "--port", "-p"),
):
    """List all discovered plugins and their status."""
    # Prefer live server data (includes next_run, last_run_status)
    data = _api("GET", "/api/plugins/", port=port)
    if data is not None:
        plugins = data
    else:
        manager, db, _ = _build_manager(config_path)
        plugins = [
            {
                "name": s.name, "version": s.version, "type": s.type,
                "enabled": s.enabled, "schedule": manager.manifests[s.name].schedule,
                "last_run": s.last_run, "last_run_status": s.last_run_status,
                "description": manager.manifests[s.name].description,
            }
            for s in manager.get_all_plugins()
        ]
        db.disconnect()

    if not plugins:
        console.print("[yellow]No plugins found[/yellow]")
        return

    table = Table(title="PiOS Plugins")
    table.add_column("Name", style="cyan", no_wrap=True)
    table.add_column("Ver", style="magenta")
    table.add_column("Type", style="blue")
    table.add_column("Enabled")
    table.add_column("Schedule")
    table.add_column("Last run")
    table.add_column("Description", overflow="fold")

    for p in plugins:
        enabled = "[green]yes[/green]" if p.get("enabled") else "[red]no[/red]"
        status_color = {
            "success": "green", "failed": "red", "skipped": "yellow",
        }.get(p.get("last_run_status") or "", "dim")
        last = f"[{status_color}]{p.get('last_run_status') or '—'}[/{status_color}]"
        table.add_row(
            p["name"], p.get("version", "?"), p.get("type", "?"),
            enabled, p.get("schedule") or "—", last,
            (p.get("description") or "")[:60],
        )

    console.print(table)


@plugin_app.command("enable")
def plugin_enable(
    name: str = typer.Argument(..., help="Plugin name"),
    port: int = typer.Option(9100, "--port", "-p"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Enable a plugin."""
    data = _api("POST", f"/api/plugins/{name}/enable", port=port)
    if data is not None:
        console.print(f"[green]✓ {name} enabled[/green]")
        return
    # offline fallback
    manager, db, _ = _build_manager(config_path)
    if manager.enable_plugin(name):
        console.print(f"[green]✓ {name} enabled[/green]")
    else:
        console.print(f"[red]Plugin {name} not found[/red]")
    db.disconnect()


@plugin_app.command("disable")
def plugin_disable(
    name: str = typer.Argument(..., help="Plugin name"),
    port: int = typer.Option(9100, "--port", "-p"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Disable a plugin."""
    data = _api("POST", f"/api/plugins/{name}/disable", port=port)
    if data is not None:
        console.print(f"[yellow]✓ {name} disabled[/yellow]")
        return
    manager, db, _ = _build_manager(config_path)
    if manager.disable_plugin(name):
        console.print(f"[yellow]✓ {name} disabled[/yellow]")
    else:
        console.print(f"[red]Plugin {name} not found[/red]")
    db.disconnect()


@plugin_app.command("install")
def plugin_install(
    source: str = typer.Argument(..., help="Path to plugin directory"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Install a plugin by copying it to ~/.pios/plugins/."""
    from pios.core.config import PiOSConfig

    config = PiOSConfig.from_file(config_path)
    src = Path(source).expanduser().resolve()

    if not src.is_dir():
        console.print(f"[red]Not a directory: {src}[/red]")
        raise typer.Exit(1)

    manifest = src / "plugin.yaml"
    if not manifest.exists():
        console.print(f"[red]No plugin.yaml found in {src}[/red]")
        raise typer.Exit(1)

    # Install into the first writable plugin dir (prefer ~/.pios/plugins)
    plugin_dir = Path(config.plugin_dirs[0]) if config.plugin_dirs else Path.home() / ".pios" / "plugins"
    dest = plugin_dir / src.name

    if dest.exists():
        console.print(f"[yellow]Overwriting existing plugin at {dest}[/yellow]")
        shutil.rmtree(dest)

    shutil.copytree(str(src), str(dest))
    console.print(f"[green]✓ Installed {src.name} → {dest}[/green]")
    console.print("Restart PiOS (or use the UI reload button) for changes to take effect.")


@plugin_app.command("runs")
def plugin_runs(
    name: str = typer.Argument(..., help="Plugin name"),
    limit: int = typer.Option(10, "--limit", "-n"),
    port: int = typer.Option(9100, "--port", "-p"),
):
    """Show recent run history for a plugin."""
    data = _api("GET", f"/api/plugins/{name}/runs?limit={limit}", port=port)
    if data is None:
        console.print(f"[red]Server not available on port {port}[/red]")
        raise typer.Exit(1)

    runs = data.get("runs", [])
    if not runs:
        console.print(f"[yellow]No runs found for {name}[/yellow]")
        return

    table = Table(title=f"Run history: {name}")
    table.add_column("Started at")
    table.add_column("Status")
    table.add_column("Duration")
    table.add_column("Error")

    for r in runs:
        status_color = {"success": "green", "failed": "red"}.get(r.get("status", ""), "dim")
        dur = f"{r['duration_ms']}ms" if r.get("duration_ms") else "—"
        err = (r.get("error_message") or "")[:60]
        table.add_row(
            r.get("started_at", "?"),
            f"[{status_color}]{r.get('status', '?')}[/{status_color}]",
            dur, err,
        )
    console.print(table)


# ── pios docs … ───────────────────────────────────────────────────────────────

@docs_app.command("list")
def docs_list(
    source: Optional[str] = typer.Option(None, "--source", "-s", help="Filter by source"),
    date: Optional[str] = typer.Option(None, "--date", "-d", help="Filter by date (YYYY-MM-DD)"),
    limit: int = typer.Option(20, "--limit", "-n"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
    port: int = typer.Option(9100, "--port", "-p"),
):
    """List documents in the vault."""
    params = f"?limit={limit}"
    if source:
        params += f"&source={source}"
    if date:
        params += f"&date_from={date}&date_to={date}"

    data = _api("GET", f"/api/documents/{params}", port=port)
    if data is not None:
        docs = data.get("documents", [])
    else:
        # offline: query DB directly
        from pios.core.config import PiOSConfig
        from pios.core.database import Database
        config = PiOSConfig.from_file(config_path)
        db = Database(config.database.path)
        db.init_schema()
        raw = db.get_documents(source=source, date_from=date, date_to=date, limit=limit)
        docs = [{"doc_id": d["id"], "title": d["title"], "source": d["source"],
                 "type": d["type"], "date": d["date"]} for d in raw]
        db.disconnect()

    if not docs:
        console.print("[yellow]No documents found[/yellow]")
        return

    table = Table(title="Document Vault")
    table.add_column("Title", overflow="fold")
    table.add_column("Source", style="cyan", no_wrap=True)
    table.add_column("Type", style="blue")
    table.add_column("Date", style="magenta")

    for d in docs:
        table.add_row(
            d.get("title") or "Untitled",
            d.get("source", "?"),
            d.get("type", "?"),
            d.get("date") or "—",
        )
    console.print(table)


@docs_app.command("search")
def docs_search(
    query: str = typer.Argument(..., help="Search query"),
    limit: int = typer.Option(10, "--limit", "-n"),
    port: int = typer.Option(9100, "--port", "-p"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Full-text search the document vault."""
    data = _api("GET", f"/api/documents/search/query?q={query}&limit={limit}", port=port)
    if data is not None:
        results = data.get("results", [])
    else:
        from pios.core.config import PiOSConfig
        from pios.core.database import Database
        from pios.document.store import DocumentStore
        config = PiOSConfig.from_file(config_path)
        db = Database(config.database.path)
        db.init_schema()
        doc_store = DocumentStore(config.storage.vault_path, db)
        found = doc_store.search(query, limit=limit)
        results = [{"doc_id": d.doc_id, "title": d.title, "source": d.source,
                    "type": d.data_type, "date": d.date} for d in found]
        db.disconnect()

    if not results:
        console.print(f"[yellow]No results for '{query}'[/yellow]")
        return

    table = Table(title=f"Search: {query}")
    table.add_column("Title", overflow="fold")
    table.add_column("Source", style="cyan")
    table.add_column("Date", style="magenta")

    for r in results:
        table.add_row(r.get("title") or "Untitled", r.get("source", "?"), r.get("date") or "—")
    console.print(table)


@docs_app.command("show")
def docs_show(
    doc_id: str = typer.Argument(..., help="Document ID"),
    port: int = typer.Option(9100, "--port", "-p"),
    config_path: Optional[str] = typer.Option(None, "--config", "-c"),
):
    """Print the full content of a document."""
    data = _api("GET", f"/api/documents/{doc_id}", port=port)
    if data is None:
        from pios.core.config import PiOSConfig
        from pios.core.database import Database
        from pios.document.store import DocumentStore
        config = PiOSConfig.from_file(config_path)
        db = Database(config.database.path)
        db.init_schema()
        doc_store = DocumentStore(config.storage.vault_path, db)
        doc = doc_store.get(doc_id)
        db.disconnect()
        if not doc:
            console.print(f"[red]Document {doc_id} not found[/red]")
            raise typer.Exit(1)
        text = doc.content.get("text", "") if doc.content else ""
        console.print(Panel(text, title=doc.title or doc_id))
    else:
        text = (data.get("content") or {}).get("text", json.dumps(data.get("content"), indent=2))
        console.print(Panel(text, title=data.get("title") or doc_id))


if __name__ == "__main__":
    app()
