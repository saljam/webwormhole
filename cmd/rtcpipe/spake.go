package main

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/nacl/secretbox"
	"salsa.debian.org/vasudev/gospake2"
)

/*
metadata
	?filetype
	?size
	?name

integrity check?

resumption
	offset?
	lineaer hashed blocks?
	merkle tree?

simple header, stream secretboxes
*/

type tunnel struct {
	rcounter uint64
	wcounter uint64
	key      [32]byte

	rbuf []byte
	wbuf []byte

	rw io.ReadWriter
}

// Assume p is big enough for message.
func (t *tunnel) Read(p []byte) (n int, err error) {
	nonce := [24]byte{}
	binary.LittleEndian.PutUint64(nonce[:8], t.rcounter)
	t.rcounter++

	n, err = t.rw.Read(t.rbuf)
	if err != nil {
		return
	}

	buf, ok := secretbox.Open(p[:0], t.rbuf[:n], &nonce, &t.key)
	if !ok {
		return 0, errors.New("could not open secretbox")
	}
	return len(buf), nil
}

func (t *tunnel) Write(p []byte) (n int, err error) {
	nonce := [24]byte{}
	binary.LittleEndian.PutUint64(nonce[:8], t.wcounter)
	t.wcounter++

	t.wbuf = secretbox.Seal(t.wbuf[:0], p, &nonce, &t.key)
	_, err = t.rw.Write(t.wbuf)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// NewTunnel initiates a SPAKE2-secured tunnel.
func NewTunnel(password, id string, rw io.ReadWriter) (io.ReadWriter, error) {
	s := gospake2.SPAKE2Symmetric(gospake2.NewPassword(password), gospake2.NewIdentityS(id))
	msg := s.Start()
	_, err := fmt.Fprintf(rw, "rtcpipe-spake2 %s\n", base64.URLEncoding.EncodeToString(msg))
	if err != nil {
		return nil, err
	}

	buf := make([]byte, 16<<10+secretbox.Overhead)
	_, err = rw.Read(buf)
	if err != nil {
		return nil, err
	}
	var remote64 string
	_, err = fmt.Sscanf(string(buf), "rtcpipe-spake2 %s\n", &remote64)
	if err != nil {
		return nil, err
	}
	rmsg, err := base64.URLEncoding.DecodeString(remote64)
	if err != nil {
		return nil, err
	}
	key, err := s.Finish(rmsg)
	if err != nil {
		return nil, err
	}

	// We have a key.

	t := tunnel{
		rbuf: buf,
		wbuf: make([]byte, 16<<10+secretbox.Overhead),
		rw:   rw,
	}
	copy(t.key[:], key)

	n, err := t.Write([]byte("hello\n"))
	fmt.Printf("sent, %v %v", n, err)
	b := make([]byte, 200)
	n, err = t.Read(b)
	fmt.Printf("received, %v %v", n, err)
	fmt.Println(string(b))

	return &t, nil
}
