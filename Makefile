.PHONY: help init install dev serve test clean lint format docker-build docker-up docker-down

help:
	@echo "PiOS - Personal Intelligence OS"
	@echo ""
	@echo "Available commands:"
	@echo "  make init           Initialize PiOS configuration"
	@echo "  make install        Install dependencies"
	@echo "  make dev            Run backend in development mode"
	@echo "  make serve          Run API server"
	@echo "  make test           Run tests"
	@echo "  make clean          Clean temporary files"
	@echo "  make lint           Run linters"
	@echo "  make format         Format code"
	@echo "  make docker-build   Build Docker image"
	@echo "  make docker-up      Start Docker containers"
	@echo "  make docker-down    Stop Docker containers"

init:
	cd backend && python -m pios.main --init

install:
	cd backend && pip install -e .
	cd frontend && npm install

dev:
	cd backend && python -m uvicorn pios.main:app --reload --host 0.0.0.0 --port 8000

serve:
	cd backend && python -m uvicorn pios.main:app --host 0.0.0.0 --port 8000

test:
	cd backend && pytest tests/ -v

clean:
	find . -type f -name "*.pyc" -delete
	find . -type d -name "__pycache__" -delete
	find . -type d -name "*.egg-info" -delete
	rm -rf build/ dist/
	rm -rf node_modules/
	rm -rf .pytest_cache/

lint:
	cd backend && ruff check pios tests
	cd backend && mypy pios

format:
	cd backend && black pios tests
	cd backend && ruff check --fix pios tests
	cd frontend && npm run lint

docker-build:
	docker-compose -f docker/docker-compose.yml build

docker-up:
	docker-compose -f docker/docker-compose.yml up -d

docker-down:
	docker-compose -f docker/docker-compose.yml down

.DEFAULT_GOAL := help
