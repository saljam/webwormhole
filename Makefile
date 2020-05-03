GOROOT := $(shell go env GOROOT)

.PHONY: serve
all: help
help:
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

wasm: ## Compile to wasm
	GOOS=js GOARCH=wasm go build -o web/util.wasm ./web
	cp $(GOROOT)/misc/wasm/wasm_exec.js ./web

serve: wasm ## Run development
	go run ./cmd/ww server -http="localhost:8000" -https="" -ui="$(PWD)/web"
