.PHONY: wasm
wasm:
	go generate ./web

.PHONY: serve wasm
serve: wasm
	go run ./cmd/ww server -http="localhost:8000" -https=""

.PHONY: image
image:
	$(eval NAME := "webwormhole-$(shell date -u +%Y%m%d%H%M%S)")
	$(eval DIR := $(shell mktemp -d)) # TODO clean this up.
	docker build -f werkzeuge/Dockerfile -t webwormhole .
	linuxkit build -format raw-bios -dir $(DIR) werkzeuge/linuxkit.yaml
	mv "$(DIR)/linuxkit-bios.img" "$(HOME)/Desktop/$(NAME).img"

.PHONY: help
help:
	@awk -F':[^#]*##' '/^[a-zA-Z0-9_]+:.*##/{print $$1"\t"$$2}' $(MAKEFILE_LIST) | sort
