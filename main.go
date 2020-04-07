// Command cpace-machine is a netcat-like pipe over WebRTC.
//
// WebRTC uses DTLS-RSTP (https://tools.ietf.org/html/rfc5764) to secure its
// data. The mechanism it uses to securely exchange keys relies on exchanging
// metadata that includes both endpoints' certificate fingerprints via some
// trusted channel, typically a signalling server over https and websockets.
// More in RFC5763 (https://tools.ietf.org/html/rfc5763).
//
// This program is an attempt to remove the signalling server from the trust
// model by using a PAKE to estabish the authenticity of the WebRTC metadata.
// In other words, it's a clone of Magic Wormhole made to use WebRTC as the
// transport.
//
// The handshake needs a signalling server that facilitates exchanging arbitrary
// messages via a slot system. The package minsig implements such a server.
//
// Rough sketch of the handshake:
//
//	Peer A             Signalling Server              Peer B
//	----PUT /slot if-match:0--->
//	    pake_msg_a
//	                             <---PUT /slot if-match:0---
//	                                 pake_msg_a
//	                             --status:Conflict etag:X-->
//	                                 pake_msg_a
//	                             <---PUT /slot if-match:X---
//	                                 pake_msg_b+sbox(offer)
//	<-----status:OK etag:X------
//	    pake_msg_b+sbox(offer)
//	--DELETE /slot if-match:X-->
//	    sbox(answer)
//	                             ---status:OK etag:X------->
//	                                 sbox(answer)
package main

import (
	crand "crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

/*
thoughts on metadata
	?filetype
	?size
	?name

no-metadata stream is also nice to keep as an option

integrity check?

resumption
	offset + checksum
	fancier? rsync-style chunks + rolling checksum?

simple header, stream secretboxes
*/

type fileHeader struct {
	Name string
	Size int
	Type string
}

func usage() {
	fmt.Fprintf(flag.CommandLine.Output(), `cpace-machine creates secure ephemeral pipes between computers.

usage:

  %s [code]

flags:
`, os.Args[0])
	flag.PrintDefaults()
}

func main() {
	flag.Usage = usage
	iceserv := flag.String("ice", "stun:stun.l.google.com:19302", "stun or turn servers to use")
	sigserv := flag.String("minsig", "https://minimumsignal.0f.io/", "signalling server to use")
	slot := flag.String("slot", "", "explicitly choose a slot")
	pass := flag.String("password", "", "explicitly choose a password")
	len := flag.Int("length", 2, "lenfth of generated secret")
	receive := flag.Bool("receive", false, "receive a file")
	cwd, _ := os.Getwd()
	directory := flag.String("directory", cwd, "directory to put downloaded files")
	flag.Parse()
	if *directory == "" {
		log.Fatal("No ouput directory")
	}
	code := strings.Join(flag.Args(), "-")

	// TODO use pgp words for code

	var c *Conn
	var err error
	switch {
	case *slot == "" && *pass == "" && code == "":
		// New wormhole.
		passbytes := make([]byte, *len)
		if _, err := io.ReadFull(crand.Reader, passbytes); err != nil {
			log.Fatalf("could not generate password: %v", err)
		}
		passwords := strings.Join(EncodeWords(passbytes), "-")
		s, r, err := Wormhole(passwords, *sigserv, strings.Split(*iceserv, ","))
		if err != nil {
			log.Fatalf("could not create wormhole: %v", err)
		}
		fmt.Fprintf(flag.CommandLine.Output(), "%s-%s\n", s, passwords)
		c, err = r()
		if err != nil {
			log.Fatalf("could not dial: %v", err)
		}
	case *slot == "" && *pass == "" && code != "":
		// Join wormhole.
		parts := strings.Split(code, "-")
		c, err = Dial(parts[0], strings.Join(parts[1:], "-"), *sigserv, strings.Split(*iceserv, ","))
		if err != nil {
			log.Fatalf("could not dial: %v", err)
		}
	case *slot != "" && *pass != "" && code == "":
		// Explicit slot and password.
		c, err = Dial(*slot, *pass, *sigserv, strings.Split(*iceserv, ","))
		if err != nil {
			log.Fatalf("could not dial: %v", err)
		}
	default:
		flag.Usage()
		os.Exit(-1)
	}

	// TODO (optionally) ask for confirmation before moving data

	done := make(chan struct{})
	// The recieve end of the pipe.
	go func() {
		out := os.Stdout

		if *receive {
			// TODO use a buffered read to do this more cleanly
			buf := make([]byte, 1024)
			n, err := c.Read(buf)
			if err != nil {
				log.Fatal("Could not read file header")
			}

			var header fileHeader
			err = json.Unmarshal(buf[:n], &header)
			if err != nil {
				log.Fatal("Could not decode file header")
			}

			out, err = os.Create(filepath.Join(*directory, filepath.Clean(header.Name)))
			if err != nil {
				log.Fatal("Could not create output file ", header.Name)
			}

			defer out.Close()
			log.Println("Receiving ", header.Name)
		}
		// Give the copy buffer 64k so the webrtc data channel doesn't barf on us
		_, err := io.CopyBuffer(out, c, make([]byte, 64<<10))
		if err != nil {
			log.Printf("could not write to stdout: %v", err)
		}
		//log.Printf("debug: rx %v", n)
		done <- struct{}{}
	}()
	// The send end of the pipe.
	go func() {
		_, err := io.Copy(c, os.Stdin)
		if err != nil {
			log.Printf("could not write to channel: %v", err)
		}
		//log.Printf("debug: tx %v", n)
		done <- struct{}{}
	}()
	<-done
	c.Close()
}
