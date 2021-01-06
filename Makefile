.PHONY: wasm
wasm:
	GOOS=js GOARCH=wasm go build -o ./web/webwormhole.wasm ./web
	cp $(shell go env GOROOT)/misc/wasm/wasm_exec.js ./web/wasm_exec.js

.PHONY: webwormhole-ext.zip
webwormhole-ext.zip: wasm
	zip -j webwormhole-ext.zip ./web/* -x '*.git*' '*.go' '*Dockerfile'

.PHONY: webwormhole-src.zip
webwormhole-src.zip:
	zip -r -FS webwormhole-src.zip  * -x '*.git*' webwormhole-src.zip webwormhole-ext.zip

.PHONY: all
all: webwormhole-ext.zip

.PHONY: fmt
fmt:
	# build rome conainer with docker build -t rome ./web
	docker run --rm -it -w /src -v $(PWD)/web:/src rome check --apply
	go fmt ./...
