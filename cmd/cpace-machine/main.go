// Command cpace-machine is a tool to move files and other data over WebRTC.
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

	"github.com/saljam/cpace-machine/wordlist"
	"github.com/saljam/cpace-machine/wormhole"
)

func usage() {
	fmt.Fprintf(flag.CommandLine.Output(), `cpace-machine creates ephemeral pipes between computers.

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
	code := flag.String("code", "", "connection code")
	len := flag.Int("length", 2, "length of generated secret")
	receive := flag.Bool("receive", false, "receive a file")
	directory := flag.String("directory", ".", "directory to put downloaded files")
	flag.Parse()

	var c *wormhole.Conn
	var err error
	if *code == "" {
		// New wormhole.
		passbytes := make([]byte, *len)
		if _, err := io.ReadFull(crand.Reader, passbytes); err != nil {
			log.Fatalf("could not generate password: %v", err)
		}
		password := strings.Join(wordlist.Encode(passbytes), "-")
		s, r, err := wormhole.Wormhole(password, *sigserv, strings.Split(*iceserv, ","))
		if err != nil {
			log.Fatalf("could not create wormhole: %v", err)
		}
		fmt.Fprintf(flag.CommandLine.Output(), "%s-%s\n", s, password)
		c, err = r()
		if err != nil {
			log.Fatalf("could not dial: %v", err)
		}
	} else {
		// Join wormhole.
		parts := strings.Split(*code, "-")
		c, err = wormhole.Dial(parts[0], strings.Join(parts[1:], "-"), *sigserv, strings.Split(*iceserv, ","))
		if err != nil {
			log.Fatalf("could not dial: %v", err)
		}
	}

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

			var header header
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
