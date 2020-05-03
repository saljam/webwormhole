GOROOTDIR := $(shell go env GOROOT)


all: help
help:
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

serve: ## Run development
	GOOS=js GOARCH=wasm go build -o web/util.wasm ./web
	cp $(GOROOTDIR)/misc/wasm/wasm_exec.js ./web
	go run ./cmd/ww server -http="localhost:8000" -https="" -ui="$(PWD)/web"