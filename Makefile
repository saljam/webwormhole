wasm: ## Compile to wasm
	go generate ./web

serve: wasm ## Run development
	go run ./cmd/ww server -http="localhost:8000" -https="" -ui="$(PWD)/web"

.PHONY: serve wasm
help:
	@awk -F':[^#]*##' '/^[a-zA-Z0-9_]+:.*##/{print $$1"\t"$$2}' $(MAKEFILE_LIST) | sort


