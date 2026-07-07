# Self-contained wetter image: frontend build embedded in the Go
# binary (served at /), API under /api, fetch loops per wetter.yaml.
FROM node:22-alpine AS webui
RUN corepack enable
WORKDIR /src
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build

FROM golang:1.26-alpine AS build
# git describe output, passed in by `make compose-up` (no .git in the context)
ARG VERSION=dev
WORKDIR /src
COPY backend/go.mod backend/go.sum backend/
RUN cd backend && go mod download
COPY backend/ backend/
COPY --from=webui /src/dist backend/internal/webui/dist
RUN find backend/internal/webui/dist -type f ! -name '*.gz' -exec gzip -9 {} \; \
 && cd backend && CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/pspoerri/wetter/internal/api.version=${VERSION}" \
    -o /wetter ./cmd/wetter

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /wetter /usr/local/bin/wetter
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["wetter"]
CMD ["serve", "--fetch", "--config", "wetter.yaml", "--addr", ":8080"]
