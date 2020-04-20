// Command cpace-machine is a tool to move files and other data over WebRTC.
package main

import (
	crand "crypto/rand"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"github.com/saljam/cpace-machine/wordlist"
	"github.com/saljam/cpace-machine/wormhole"
)

var subcmds = map[string]func(args ...string){
	"send":    send,
	"receive": receive,
	"pipe":    pipe,
	"server":  server,
}

var (
	iceserv = flag.String("ice", "stun:stun.l.google.com:19302", "stun or turn servers to use")
	sigserv = flag.String("minsig", "https://cpace-machine.0f.io/", "signalling server to use")
)

func usage() {
	w := flag.CommandLine.Output()
	fmt.Fprintf(w, "cpace-machine creates ephemeral pipes between computers.\n\n")
	fmt.Fprintf(w, "usage:\n\n")
	fmt.Fprintf(w, "  %s [flags] <command> [arguments]\n\n", os.Args[0])
	fmt.Fprintf(w, "commands:\n")
	for key := range subcmds {
		fmt.Fprintf(w, "  %s\n", key)
	}
	fmt.Fprintf(w, "\nflags:\n")
	flag.PrintDefaults()
}

func main() {
	flag.Usage = usage
	flag.Parse()
	if flag.NArg() < 1 {
		usage()
		os.Exit(2)
	}
	cmd, ok := subcmds[flag.Arg(0)]
	if !ok {
		flag.Usage()
		os.Exit(2)
	}
	cmd(flag.Args()...)
}

func newConn(code string, length int) *wormhole.Conn {
	if code != "" {
		// Join wormhole.
		parts := strings.Split(code, "-")
		c, err := wormhole.Dial(parts[0], strings.Join(parts[1:], "-"), *sigserv, strings.Split(*iceserv, ","))
		if err != nil {
			log.Fatalf("could not dial: %v", err)
		}
		return c
	}
	// New wormhole.
	passbytes := make([]byte, length)
	if _, err := io.ReadFull(crand.Reader, passbytes); err != nil {
		log.Fatalf("could not generate password: %v", err)
	}
	password := strings.Join(wordlist.Encode(passbytes), "-")
	s, r, err := wormhole.Wormhole(password, *sigserv, strings.Split(*iceserv, ","))
	if err != nil {
		log.Fatalf("could not create wormhole: %v", err)
	}
	fmt.Fprintf(flag.CommandLine.Output(), "%s-%s\n", s, password)
	c, err := r()
	if err != nil {
		log.Fatalf("could not dial: %v", err)
	}
	return c
}
