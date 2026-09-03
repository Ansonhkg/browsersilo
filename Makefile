.PHONY: setup build build-server build-ui check test verify image images up down run run-headless run-real mcp test-agent-live test-e2e

setup:
	npm install

build:
	npm run build

build-server:
	npm run build:server

build-ui:
	npm run build:ui

check:
	npm run check

test:
	npm test

verify:
	npm run verify

image:
	docker build -f container/Dockerfile -t browsersilo/brave-worker:0.4.0 .

images: build
	docker build -f container/Dockerfile -t browsersilo/brave-worker:0.4.0 .
	docker build -f container/control-plane.Dockerfile -t browsersilo/control-plane:0.4.0 .

up: build
	docker compose up -d --build

down:
	docker compose down

run: build
	node dist/src/index.js

run-headless: build-server
	node dist/src/index.js

run-real: build
	BROWSERSILO_WORKER_ADAPTER=docker node dist/src/index.js

mcp: build-server
	node dist/src/mcp/index.js

test-agent-live: build-server
	npm run acceptance:live

test-e2e: verify images
	sh scripts/test-e2e.sh
