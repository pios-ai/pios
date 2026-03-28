.PHONY: help install dev backend frontend test clean lint format docker-build docker-up docker-down

PROJECT_ROOT := $(shell pwd)

help:
	@echo "PiOS - Personal Intelligence OS"
	@echo ""
	@echo "  make install     Install all dependencies (backend + frontend)"
	@echo "  make dev         Start both backend and frontend (hot-reload)"
	@echo "  make backend     Start backend only"
	@echo "  make frontend    Start frontend only"
	@echo "  make test        Run backend tests"
	@echo "  make clean       Clean temp files"

install:
	cd backend && pip install -e .
	cd frontend && npm install

dev:
	@echo "Starting PiOS dev environment (Ctrl+C to stop both)..."
	@( \
		PYTHONPATH=$(PROJECT_ROOT)/backend python -m uvicorn pios.main:app \
			--reload --host 0.0.0.0 --port 9100 & \
		BE_PID=$$!; \
		(cd $(PROJECT_ROOT)/frontend && npm run dev) & \
		FE_PID=$$!; \
		trap "kill $$BE_PID $$FE_PID 2>/dev/null; exit 0" INT TERM; \
		wait; \
	)

backend:
	PYTHONPATH=$(PROJECT_ROOT)/backend python -m uvicorn pios.main:app \
		--reload --host 0.0.0.0 --port 9100

frontend:
	cd frontend && npm run dev

test:
	cd backend && python -m pytest tests/ -v

clean:
	find . -type f -name "*.pyc" -delete
	find . -type d -name "__pycache__" -delete
	find . -type d -name "*.egg-info" -delete
	rm -rf build/ dist/ .pytest_cache/

lint:
	cd backend && ruff check pios tests

format:
	cd backend && black pios tests

docker-build:
	docker-compose -f docker/docker-compose.yml build

docker-up:
	docker-compose -f docker/docker-compose.yml up -d

docker-down:
	docker-compose -f docker/docker-compose.yml down

.DEFAULT_GOAL := help
