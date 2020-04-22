// Command cpace-machine is a tool to move files and other data over WebRTC.
package main

import (
	crand "crypto/rand"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"strings"

	"github.com/saljam/cpace-machine/wordlist"
	"github.com/saljam/cpace-machine/wormhole"
	"rsc.io/qr"
)

var subcmds = map[string]func(args ...string){
	"send":    send,
	"receive": receive,
	"pipe":    pipe,
	"server":  server,
}

var (
	iceserv = flag.String("ice", "stun:stun.l.google.com:19302", "stun or turn servers to use")
	sigserv = flag.String("signal", "https://cpacemachine.0f.io/", "signalling server to use")
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
	slot, dial, err := wormhole.Wormhole(password, *sigserv, strings.Split(*iceserv, ","))
	if err != nil {
		log.Fatalf("could not create wormhole: %v", err)
	}
	code = slot + "-" + password

	fmt.Fprintf(flag.CommandLine.Output(), "%s\n", code)
	printurl(code)

	c, err := dial()
	if err != nil {
		log.Fatalf("could not dial: %v", err)
	}
	return c
}

func printurl(code string) {
	out := flag.CommandLine.Output()
	u, err := url.Parse(*sigserv)
	if err != nil {
		return
	}
	u.Fragment = code
	qrcode, err := qr.Encode(u.String(), qr.L)
	if err != nil {
		return
	}
	for x := 0; x < qrcode.Size; x++ {
		fmt.Fprintf(out, "█")
	}
	fmt.Fprintf(out, "████████\n")
	for x := 0; x < qrcode.Size; x++ {
		fmt.Fprintf(out, "█")
	}
	fmt.Fprintf(out, "████████\n")
	for y := 0; y < qrcode.Size; y += 2 {
		fmt.Fprintf(out, "████")
		for x := 0; x < qrcode.Size; x++ {
			switch {
			case qrcode.Black(x, y) && qrcode.Black(x, y+1):
				fmt.Fprintf(out, " ")
			case qrcode.Black(x, y):
				fmt.Fprintf(out, "▄")
			case qrcode.Black(x, y+1):
				fmt.Fprintf(out, "▀")
			default:
				fmt.Fprintf(out, "█")
			}
		}
		fmt.Fprintf(out, "████\n")
	}
	for x := 0; x < qrcode.Size; x++ {
		fmt.Fprintf(out, "█")
	}
	fmt.Fprintf(out, "████████\n")
	for x := 0; x < qrcode.Size; x++ {
		fmt.Fprintf(out, "█")
	}
	fmt.Fprintf(out, "████████\n")
	fmt.Fprintf(out, "%s\n", u.String())
}
