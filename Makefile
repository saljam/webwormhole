wasm: ## Compile to wasm
	GOOS=js GOARCH=wasm go build -o web/util.wasm ./web
	cp $(shell go env GOROOT)/misc/wasm/wasm_exec.js ./web

serve: wasm ## Run development
	go run ./cmd/ww server -http="localhost:8000" -https="" -ui="$(PWD)/web"

.PHONY: serve wasm
help:
	@awk -F':[^#]*##' '/^[a-zA-Z0-9_]+:.*##/{print $$1"\t"$$2}' $(MAKEFILE_LIST) | sort


