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

// TODO benchmark buffers.

// TODO werbrtc already uses dtls, and the certificate fingerprints are in the sdp.
// Maybe use pake over the signalling server to sbox the sdp only, instead of sboxing
// the stream?

func main() {
	iceserv := flag.String("ice", "stun:stun.l.google.com:19302", "stun or turn servers to use")
	sigserv := flag.String("minsig", "https://minimumsignal.0f.io/", "signalling server to use")
	flag.Parse()
	if flag.NArg() != 2 {
		flag.PrintDefaults()
		os.Exit(-1)
	}
	// TODO use similar dictionaries and code format to magic wormhole?
	// TODO generate and print slots and passwords
	slot := flag.Arg(0)
	pass := flag.Arg(1)

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

	// The identity argument is for identity binding in the PAKE. Cf. Unknown Key-Share
	// Attack. https://tools.ietf.org/html/draft-ietf-mmusic-sdp-uks-03
	//
	// In the context of a single-guess passcode program like this or magic-wormhole we
	// do not have ahead of time information about the identity of the remote party. We
	// just have what the signalling server tells us. Nevertheless this allows us to at
	// least verify the integrity of the signal exchange.
	//
	// TODO use offer and answer sdps as A and B pake identities instead of c.ID(), which is
	// only the offer sdp.
	//
	// TODO maybe add a nonce in the offers and answers? otoh candidate 3-tuples and sdp
	// session-id are probably enough, despite:
	//		The method of <sess-id> allocation is up to the creating tool, but
	//		it has been suggested that a Network Time Protocol (NTP) format
	//		timestamp be used to ensure uniqueness [13].
	// https://tools.ietf.org/html/rfc4566#section-5.2
	t, err := NewTunnel(pass, slot + c.ID(), c)
	if err != nil {
		log.Fatalf("could establish tunnel: %v", err)
	}

	done := make(chan struct{})
	// The recieve end of the pipe.
	go func() {
		_, err := io.Copy(os.Stdout, t)
		if err != nil {
			log.Printf("could not write to stdout: %v", err)
		}
		//log.Printf("debug: rx %v", n)
		done <- struct{}{}
	}()
	// The send end of the pipe.
	go func() {
		_, err := io.Copy(t, os.Stdin)
		if err != nil {
			log.Printf("could not write to channel: %v", err)
		}
		//log.Printf("debug: tx %v", n)
		done <- struct{}{}
	}()
	<-done
	c.Close()
}
