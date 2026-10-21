# Common workflows. Node 24 is required (see .nvmrc).
SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install dev infra up down logs test test-int e2e lint check images observability kind-up kind-deploy kind-down helm-lint

help: ## Show this help
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	pnpm install

infra: ## Start Postgres, Valkey and Mailpit
	docker compose up -d --wait

dev: infra ## Run api, worker and web with hot reload
	pnpm db:migrate
	pnpm dev

up: ## Run the full stack in containers (http://localhost:8080)
	docker compose --profile app up -d --build --wait

down: ## Stop all containers
	docker compose --profile app --profile ollama --profile observability down

logs: ## Tail container logs
	docker compose --profile app logs -f

observability: ## Start the OTel collector + Grafana LGTM (http://localhost:3300)
	docker compose --profile observability up -d

test: ## Unit tests
	pnpm test

test-int: ## Integration tests (needs Docker)
	pnpm test:integration

e2e: ## Playwright against a running stack (E2E_BASE_URL, default :5173)
	pnpm exec playwright test

lint: ## Lint, format check, typecheck
	pnpm lint && pnpm format:check && pnpm typecheck

check: lint test test-int ## Everything CI runs before images

images: ## Build all container images
	docker build -f docker/node-app.Dockerfile --build-arg APP=api -t lifeos-api:local .
	docker build -f docker/node-app.Dockerfile --build-arg APP=worker -t lifeos-worker:local .
	docker build -f docker/web.Dockerfile -t lifeos-web:local .

helm-lint: ## Lint the Helm chart
	helm lint deploy/helm/lifeos --strict -f deploy/helm/lifeos/values-kind.yaml

kind-up: ## Create a local kind cluster with backing services
	./scripts/kind-up.sh

kind-deploy: ## Build, load and install the chart on kind, then helm test
	./scripts/kind-deploy.sh

kind-down: ## Delete the kind cluster
	kind delete cluster --name lifeos
