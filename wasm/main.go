package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"syscall/js"

	"filippo.io/cpace"
	"golang.org/x/crypto/hkdf"
)

// Side A

var state *cpace.State

func start(_ js.Value, args []js.Value) interface{} {
	dst := args[0] // Uint8Array
	pass := args[1].String()

	var msgA []byte
	var err error
	msgA, state, err = cpace.Start(pass, cpace.NewContextInfo("", "", nil))
	if err != nil {
		panic(err)
	}
	js.CopyBytesToJS(dst, msgA)

	return nil
}

func finish(_ js.Value, args []js.Value) interface{} {
	dst := args[0]    // Uint8Array
	jsmsgB := args[1] // Uint8Array

	msgB := make([]byte, 32) // TODO i think 32
	js.CopyBytesToGo(msgB, jsmsgB)

	mk, err := state.Finish(msgB)
	if err != nil {
		panic(err)
	}
	hkdf := hkdf.New(sha256.New, mk, nil, nil)
	key := [32]byte{}
	_, err = io.ReadFull(hkdf, key[:])
	if err != nil {
		panic(err)
	}

	js.CopyBytesToJS(dst, key[:])
	return nil
}

// Side B

func exchange(_ js.Value, args []js.Value) interface{} {
	jsKey := args[0]  // Uint8Array
	jsMsgB := args[1] // Uint8Array
	pass := args[2].String()
	jsMsgA := args[3] // Uint8Array

	msgA := make([]byte, 48)
	js.CopyBytesToGo(msgA, jsMsgA)

	msgB, mk, err := cpace.Exchange(pass, cpace.NewContextInfo("", "", nil), msgA)
	if err != nil {
		panic(err)
	}
	hkdf := hkdf.New(sha256.New, mk, nil, nil)
	key := [32]byte{}
	_, err = io.ReadFull(hkdf, key[:])
	if err != nil {
		panic(err)
	}

	js.CopyBytesToJS(jsKey, key[:])
	js.CopyBytesToJS(jsMsgB, msgB)
	return nil
}

func main() {
	js.Global().Set("cpaceStart", js.FuncOf(start))
	js.Global().Set("cpaceFinish", js.FuncOf(finish))
	js.Global().Set("cpaceExchange", js.FuncOf(exchange))
	fmt.Println("Hello, WebAssembly!")
	select {}
}
