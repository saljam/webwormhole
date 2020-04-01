package main

import (
	"crypto/sha256"
	"crypto/rand"
	"fmt"
	"io"
	"syscall/js"
	"encoding/base64"

	"filippo.io/cpace"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/nacl/secretbox"
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


func open(_ js.Value, args []js.Value) interface{} {
	encrypted64 := args[0].String()
	jsKey := args[1]

	var key [32]byte
	js.CopyBytesToGo(key[:], jsKey)

	encrypted, err := base64.URLEncoding.DecodeString(encrypted64)
	if err != nil {
		panic(err)
	}

	var nonce [24]byte
	copy(nonce[:], encrypted[:24])
	clear, ok := secretbox.Open(nil, encrypted[24:], &nonce, &key)

	if !ok {
		panic("secretbox cannot be opened")
	}

	return js.ValueOf(string(clear))
}


func seal(_ js.Value, args []js.Value) interface{} {
	clear := args[0].String()
	jsKey := args[1]

	var key [32]byte
	js.CopyBytesToGo(key[:], jsKey)

	var nonce [24]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		panic(err)
	}

	result := secretbox.Seal(nonce[:], []byte(clear), &nonce, &key)

	return base64.URLEncoding.EncodeToString(result)
}


func main() {
	js.Global().Set("cpaceStart", js.FuncOf(start))
	js.Global().Set("cpaceFinish", js.FuncOf(finish))
	js.Global().Set("cpaceExchange", js.FuncOf(exchange))

	js.Global().Set("secretboxOpen", js.FuncOf(open))
	js.Global().Set("secretboxSeal", js.FuncOf(seal))

	fmt.Println("Hello, WebAssembly!")
	select {}
}
