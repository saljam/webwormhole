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

	ravail int
	roff   int
	rbuf   []byte
	rcrypt []byte
	wcrypt []byte

	rw io.ReadWriter
}

func (t *tunnel) Read(p []byte) (int, error) {
	n := t.ravail - t.roff
	if n > len(p) {
		n = len(p)
	}

	copy(p[:n], t.rbuf[t.roff:t.roff+n])
	p = p[n:]
	t.roff += n

	if t.ravail-t.roff > 0 {
		return n, nil
	}
	t.roff = 0
	nr, err := t.rw.Read(t.rcrypt)
	if err != nil {
		return n, err
	}
	nonce := [24]byte{}
	binary.LittleEndian.PutUint64(nonce[:8], t.rcounter)
	t.rcounter++

	buf, ok := secretbox.Open(t.rbuf[:0], t.rcrypt[:nr], &nonce, &t.key)
	if !ok {
		return n, errors.New("could not open secretbox")
	}
	t.ravail = len(buf)
	nb := len(buf)
	if nb > len(p) {
		nb = len(p)
	}
	copy(p[:nb], t.rbuf[t.roff:t.roff+nb])
	t.roff += nb
	return n + nb, nil
}

func (t *tunnel) Write(p []byte) (n int, err error) {
	chunksize := 16<<10 - secretbox.Overhead
	buf := p
	for len(buf) > 0 {
		nonce := [24]byte{}
		binary.LittleEndian.PutUint64(nonce[:8], t.wcounter)
		t.wcounter++

		n := chunksize
		if len(buf) < chunksize {
			n = len(buf)
		}

		t.wcrypt = secretbox.Seal(t.wcrypt[:0], buf[:n], &nonce, &t.key)
		_, err = t.rw.Write(t.wcrypt)
		if err != nil {
			return len(p) - len(buf), err
		}

		buf = buf[n:]
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

	buf := make([]byte, 16<<10-secretbox.Overhead)
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
		rbuf:   buf,
		rcrypt: make([]byte, 16<<10),
		wcrypt: make([]byte, 16<<10),
		rw:     rw,
	}
	copy(t.key[:], key)

	_, err = t.Write([]byte("hello\n"))
	if err != nil {
		return nil, err
	}
	b := make([]byte, 200)
	n, err := t.Read(b)
	if err != nil {
		return nil, err
	}

	if string(b[:n]) != "hello\n" {
		return nil, errors.New("handshake failed")
	}

	return &t, nil
}
