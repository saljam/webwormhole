.PHONY: wasm
wasm:
	go generate ./web

.PHONY: serve
serve: wasm
	go run ./cmd/ww server -http="localhost:8000" -https=""

.PHONY: help
help:
	@awk -F':[^#]*##' '/^[a-zA-Z0-9_]+:.*##/{print $$1"\t"$$2}' $(MAKEFILE_LIST) | sort
