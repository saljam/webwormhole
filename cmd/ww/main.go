// Command ww is a tool to move files and other data over WebRTC.
package main

import (
	crand "crypto/rand"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"rsc.io/qr"
	"webwormhole.io/wordlist"
	"webwormhole.io/wormhole"
)

var subcmds = map[string]func(args ...string){
	"send":    send,
	"receive": receive,
	"pipe":    pipe,
	"server":  server,
}

var (
	iceserv = flag.String("ice", "stun:stun.l.google.com:19302", "stun or turn servers to use")
	sigserv = flag.String("signal", "https://wrmhl.link/", "signalling server to use")
)

func usage() {
	w := flag.CommandLine.Output()
	fmt.Fprintf(w, "webwormhole creates ephemeral pipes between computers.\n\n")
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

func fatalf(format string, v ...interface{}) {
	fmt.Fprintf(flag.CommandLine.Output(), format+"\n", v...)
	os.Exit(1)
}

func newConn(code string, length int) *wormhole.Conn {
	if code != "" {
		// Join wormhole.
		parts := strings.Split(code, "-")
		c, err := wormhole.Dial(parts[0], strings.Join(parts[1:], "-"), *sigserv, strings.Split(*iceserv, ","))
		if err == wormhole.ErrBadVersion {
			fatalf(
				"%s%s%s",
				"the signalling server is running an incompatable version.\n",
				"try upgrading the client:\n\n",
				"    go get webwormhole.io/cmd/ww\n",
			)
		}
		if err != nil {
			fatalf("could not dial: %v", err)
		}
		return c
	}
	// New wormhole.
	passbytes := make([]byte, length)
	if _, err := io.ReadFull(crand.Reader, passbytes); err != nil {
		fatalf("could not generate password: %v", err)
	}
	password := strings.Join(wordlist.Encode(passbytes), "-")
	slotc := make(chan string)
	go func() {
		printcode(<-slotc + "-" + password)
	}()
	c, err := wormhole.Wormhole(password, *sigserv, strings.Split(*iceserv, ","), slotc)
	if err == wormhole.ErrBadVersion {
		fatalf(
			"%s%s%s",
			"the signalling server is running an incompatable version.\n",
			"try upgrading the client:\n\n",
			"    go get webwormhole.io/cmd/ww\n",
		)
	}
	if err != nil {
		fatalf("could not dial: %v", err)
	}
	return c
}

func printcode(code string) {
	out := flag.CommandLine.Output()
	fmt.Fprintf(out, "%s\n", code)
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
