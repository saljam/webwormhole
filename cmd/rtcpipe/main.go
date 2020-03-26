// Command rtcpipe is a netcat-like pipe over WebRTC.
package main

import (
	"flag"
	"io"
	"log"
	"os"
	"strings"

	"github.com/pion/webrtc/v2"
)

func main() {
	iceserv := flag.String("ice", "stun:stun.l.google.com:19302", "stun or turn servers to use")
	sigserv := flag.String("minsig", "https://minimumsignal.0f.io/", "signalling server to use")
	flag.Parse()
	if flag.NArg() != 1 {
		flag.PrintDefaults()
		os.Exit(-1)
	}
	slot := flag.Arg(0)

	rtccfg := webrtc.Configuration{}
	if *iceserv != "" {
		srvs := strings.Split(*iceserv, ",")
		// TODO parse creds for turn servers
		for i := range srvs {
			rtccfg.ICEServers = append(rtccfg.ICEServers, webrtc.ICEServer{URLs: []string{srvs[i]}})
		}
	}

	c, err := Dial(slot, *sigserv, rtccfg)
	if err != nil {
		log.Fatalf("could not dial: %v", err)
	}

	done := make(chan struct{})
	// The recieve end of the pipe.
	go func() {
		_, err := io.Copy(os.Stdout, c)
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
