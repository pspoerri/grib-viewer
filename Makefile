# WETTER-viewer build entry points. `make help` lists all targets.
#
# Deployment:
#   make release          ONE self-contained binary: UI embedded, served at /
#                         (then: ./bin/wetter serve --config wetter.yaml)
#   make frontend         static UI bundle only (frontend/dist/) — see
#                         "Hosting the frontend as static pages" in README.md
#
# Development:
#   make serve            backend API + fetch loops on $(ADDR)
#   make dev              frontend dev server on :5173 (proxies /api to $(ADDR))
#   make ci               full local gate before pushing
#
# Knobs (override per invocation, e.g. `make serve ADDR=:9090`):
#   CONFIG  config file            (default wetter.yaml)
#   ADDR    serve listen address   (default 127.0.0.1:8080)
#   SOURCE  bench / fetch-one source id (default icond2)

GO      ?= go
BIN_DIR ?= bin
CONFIG  ?= wetter.yaml
ADDR    ?= 127.0.0.1:8080
SOURCE  ?= icond2

# Pure Go everywhere: with cgo enabled, go-tiled-eccodes' decode package
# wants libopenjp2 via pkg-config (its cgo JPEG2000 path); CGO_ENABLED=0
# selects its pure-Go decoder and keeps builds host-independent.
export CGO_ENABLED = 0

WEBUI_DIST = backend/internal/webui/dist

.PHONY: help build release embed-frontend serve fetch fetch-one dev test vet lint frontend ci bench bench-eps smoke compose-up compose-down clean

help:                   ## list targets with their descriptions
	@awk -F':.*## ' '/^[a-z-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' Makefile

build:                  ## backend binary only (no embedded UI; API-only at /)
	cd backend && $(GO) build -o ../$(BIN_DIR)/wetter ./cmd/wetter

# gzip the frontend production build into the embed dir (only .gz
# variants ship — the server decompresses for non-gzip clients)
embed-frontend: frontend ## stage frontend/dist into the Go embed dir (gzipped)
	rm -rf $(WEBUI_DIST)
	mkdir -p $(WEBUI_DIST)
	cp -R frontend/dist/. $(WEBUI_DIST)/
	find $(WEBUI_DIST) -type f ! -name '*.gz' -exec gzip -9 {} \;
	touch $(WEBUI_DIST)/.gitkeep

release: embed-frontend ## self-contained binary: API + embedded frontend at /
	cd backend && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o ../$(BIN_DIR)/wetter ./cmd/wetter
	@ls -lh $(BIN_DIR)/wetter

serve: build            ## API + configured fetch loops on $(ADDR)
	./$(BIN_DIR)/wetter serve --config $(CONFIG) --addr $(ADDR)

fetch: build            ## one fetch pass over all sources, then exit
	./$(BIN_DIR)/wetter fetch --config $(CONFIG) --once

fetch-one: build        ## one fetch pass for $(SOURCE) only
	./$(BIN_DIR)/wetter fetch --config $(CONFIG) --source $(SOURCE)

dev:                    ## frontend dev server on :5173 (proxies /api to $(ADDR))
	cd frontend && pnpm install && pnpm run dev

test:                   ## backend unit + integration tests
	cd backend && $(GO) test ./...

vet:                    ## go vet
	cd backend && $(GO) vet ./...

lint: vet               ## vet + eslint + frontend unit tests
	cd frontend && pnpm run lint

frontend:               ## static UI bundle (frontend/dist/) for any static host
	cd frontend && pnpm install && pnpm run build

ci: vet test frontend   ## full local gate (vet + tests + frontend build)

# end-to-end benchmark: fetches a bounded real subset of $(SOURCE),
# serves in-process, times the full HTTP path (backend/cmd/wetter/bench.go).
# BENCH_ARGS=--no-fetch reuses the existing buffer.
bench: build            ## end-to-end benchmark against real $(SOURCE) data
	./$(BIN_DIR)/wetter bench --config $(CONFIG) --source $(SOURCE) $(BENCH_ARGS)

bench-eps: build        ## benchmark the ensemble path (icond2eps)
	./$(BIN_DIR)/wetter bench --config $(CONFIG) --source icond2eps $(BENCH_ARGS)

smoke: build            ## live end-to-end smoke test (scripts/smoke.sh)
	./scripts/smoke.sh

# container stack: UI+API on :8080, GRIB buffer in ./data
COMPOSE ?= $(shell command -v podman-compose >/dev/null 2>&1 && echo podman-compose || echo docker compose)

compose-up:             ## UI+API container on :8080, GRIB buffer in ./data
	$(COMPOSE) up -d --build

compose-down:           ## stop the container stack
	$(COMPOSE) down

clean:                  ## remove binaries, frontend dist, embed dir
	rm -rf $(BIN_DIR) frontend/dist
	rm -rf $(WEBUI_DIST) && mkdir -p $(WEBUI_DIST) && touch $(WEBUI_DIST)/.gitkeep
