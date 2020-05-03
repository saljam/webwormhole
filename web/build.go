package main

//go:generate sh -c "GOOS=js GOARCH=wasm go build -o util.wasm "
//go:generate sh -c "cp $(go env GOROOT)/misc/wasm/wasm_exec.js ."
