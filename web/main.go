// Package jscm is a set of wrapper functions for cpace-machine to be invoked
// from via Web Assembly.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"syscall/js"

	"filippo.io/cpace"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/nacl/secretbox"
)

// Globals mean this can only be used once at a time. Ah well.
var state *cpace.State

// start(pass string) (base64msgA string)
func start(_ js.Value, args []js.Value) interface{} {
	pass := args[0].String()

	msgA, s, err := cpace.Start(pass, cpace.NewContextInfo("", "", nil))
	if err != nil {
		panic(err)
	}
	state = s

	return base64.URLEncoding.EncodeToString(msgA)
}

// finish(base64msgB string) (key []byte)
func finish(_ js.Value, args []js.Value) interface{} {
	msgB, err := base64.URLEncoding.DecodeString(args[0].String())
	if err != nil {
		panic(err)
	}

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

	dst := js.Global().Get("Uint8Array").New(32)
	js.CopyBytesToJS(dst, key[:])

	return dst
}

// finish(pass, base64msgA string) (key []byte, base64msgB string)
func exchange(_ js.Value, args []js.Value) interface{} {
	pass := args[0].String()
	msgA, err := base64.URLEncoding.DecodeString(args[1].String())
	if err != nil {
		panic(err)
	}

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

	dst := js.Global().Get("Uint8Array").New(32)
	js.CopyBytesToJS(dst, key[:])
	return []interface{}{
		dst,
		base64.URLEncoding.EncodeToString(msgB),
	}
}

// open(key []byte, base64ciphertext string) (cleartext string)
func open(_ js.Value, args []js.Value) interface{} {
	var key [32]byte
	js.CopyBytesToGo(key[:], args[0])
	encrypted, err := base64.URLEncoding.DecodeString(args[1].String())
	if err != nil {
		panic(err)
	}

	var nonce [24]byte
	copy(nonce[:], encrypted[:24])
	clear, ok := secretbox.Open(nil, encrypted[24:], &nonce, &key)
	if !ok {
		panic("secretbox cannot be opened")
	}

	return string(clear)
}

// open(key []byte, cleartext string) (base64ciphertext string)
func seal(_ js.Value, args []js.Value) interface{} {
	var key [32]byte
	js.CopyBytesToGo(key[:], args[0])
	clear := args[1].String()

	var nonce [24]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		panic(err)
	}

	result := secretbox.Seal(nonce[:], []byte(clear), &nonce, &key)

	return base64.URLEncoding.EncodeToString(result)
}

func main() {
	js.Global().Get("cm").Set("start", js.FuncOf(start))
	js.Global().Get("cm").Set("finish", js.FuncOf(finish))
	js.Global().Get("cm").Set("exchange", js.FuncOf(exchange))
	js.Global().Get("cm").Set("open", js.FuncOf(open))
	js.Global().Get("cm").Set("seal", js.FuncOf(seal))

	// TODO release functions and exit when done.
	select {}
}
