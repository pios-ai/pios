"""Shared dependency providers for FastAPI routes."""

_config = None
_database = None
_document_store = None
_llm = None
_scheduler = None
_plugin_manager = None


def get_config():
    return _config


def get_database():
    return _database


def get_document_store():
    return _document_store


def get_llm():
    return _llm


def get_scheduler():
    return _scheduler


def get_plugin_manager():
    return _plugin_manager
