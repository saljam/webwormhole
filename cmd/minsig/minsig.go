// Server minsig is a WebRTC signalling server.
//
// It facilitates establishing WebRTC connections between peers using ephemeral
// slots to hold WebRTC offers and answers.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

type sdp struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type slot struct {
	offer  sdp
	answer chan sdp
}

var slots = struct {
	m map[string]*slot
	sync.RWMutex
}{m: make(map[string]*slot)}

func serveHTTP(w http.ResponseWriter, r *http.Request) {
	slotkey := r.URL.Path
	if r.Method == http.MethodGet && slotkey == "/" {
		w.Write([]byte(indexpage))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method != http.MethodPost {
		http.Error(w, "invalid method", 400)
	}

	var msg sdp
	err := json.NewDecoder(r.Body).Decode(&msg)
	if err != nil {
		http.Error(w, "could not decode body", 400)
		return
	}

	log.Printf("%v: %v", slotkey, msg.Type)

	slots.Lock()
	s := slots.m[slotkey]
	switch {
	case s != nil && msg.Type == "offer":
		// Already have offer, pass that down
		slots.Unlock()
		err := json.NewEncoder(w).Encode(s.offer)
		if err != nil {
			log.Printf("%v", err)
		}
	case s != nil && msg.Type == "answer":
		// This is an answer to an offer, wake the other go routines up.
		slots.Unlock()
		s.answer <- msg
	case s == nil && msg.Type == "offer":
		// This is a new offer.
		s = &slot{offer: msg, answer: make(chan sdp)}
		slots.m[slotkey] = s
		slots.Unlock()
		select {
		case a := <-s.answer:
			err := json.NewEncoder(w).Encode(a)
			if err != nil {
				log.Printf("%v", err)
			}
		case <-r.Context().Done():
		}
		slots.Lock()
		delete(slots.m, slotkey)
		slots.Unlock()
	default:
		// Any other state is invalid.
		slots.Unlock()
		http.Error(w, "invalid offer description", 400)
	}
}

func main() {
	httpaddr := flag.String("http", ":http", "http listen address")
	httpsaddr := flag.String("https", ":https", "https listen address")
	secretpath := flag.String("secrets", os.Getenv("HOME")+"/keys", "path to put let's encrypt cache")
	flag.Parse()

	m := &autocert.Manager{
		Cache:  autocert.DirCache(*secretpath),
		Prompt: autocert.AcceptTOS,
		HostPolicy: func(ctx context.Context, host string) error {
			if host == "minimumsignal.0f.io" {
				return nil
			}
			return errors.New("request host does not point to allowed cname")
		},
	}

	srv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpaddr,
		Handler:      m.HTTPHandler(nil),
	}
	// Enable non-redirect plaintext http handler if https is disabled.
	if *httpsaddr == "" {
		srv.Handler = m.HTTPHandler(http.HandlerFunc(serveHTTP))
	}
	go func() { log.Fatal(srv.ListenAndServe()) }()

	ssrv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpsaddr,
		Handler:      http.HandlerFunc(serveHTTP),
		TLSConfig:    &tls.Config{GetCertificate: m.GetCertificate},
	}
	log.Fatal(ssrv.ListenAndServeTLS("", ""))
}

var indexpage = `
<!doctype html>
<meta charset=utf-8>
<title>minimum signal</title>
<style>
body {font: small arial, sans-serif;max-width: 40em;margin: auto;padding: 2em;}
pre {font: small Inconsolata, monospace;word-spacing: 0;letter-spacing: 0;}
h1 {font-size: 1.7em;text-align: center;}
h2 {font-size:1.6em;}
h3 {font-size: 1.1em;}
footer {font-size: x-small;text-align: center;}
</style>

<h1>MINIMUM SIGNAL</h1>
<p>Experimental service to handle <a href="https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API">WebRTC</a> singalling so you don't have to.</p>

<h2>RATIONALE</h2>
<p>While WebRTC's main selling point is that it is peer-to-peer, every WebRTC application needs a central signalling server to facilitate establishing this direct connection.</p>
<p>Writing these is somewhat tedious and requires setting up the infrastructure to host it. What if this existed as a service that you could just use and focus on building the client side of your WebRTC application?</p>
<p>This way, no special server-side code needs to be written. The client parts (HTML/JS/CSS) could be hosted on some static service like S3 or GitHub Pages, or they could be native applications.</p>

<h2>MODEL</h2>
<p>WebRTC uses an "offer" and "answer" model, where one party puts sends an "offer" encoded in a JSON object and the other party responds similarly with an "answer" JSON object. Minimum Signal uses a slot system to allow clients to exchange offers and answers. Slots are arbitrary strings, currently capped at 125 bytes. They can be communicated out of band. E.g. SMS, AirDrop, email, or shouted out across the room.</p>
<p>If two peers want to establish a connection:</p>
<ol>
<li>Both attempt to post their offers to the same slot.</li>
<li>Whichever gets their offer up first (A) waits for a response. The other peer (B) will get A's offer in the response when they attempt to upload theirs.</li>
<li>B discards their original offer, generates an answer based on A's offer, and posts it to the same slot.</li>
<li>A will receive B's answer and they both carry on the WebRTC nogotiations directly.</li>
<li>At this point, Minimum Signal's role is finished and the slot is free to be used by someone else.</li>
</ol>
<p>This slot model is similar to what the non-crypto parts of <a href="https://github.com/warner/magic-wormhole">Magic Wormhole</a> use.</p>

<h2>API</h2>
<pre>POST https://example.com/:slot</pre>
<p>If the body is an offer and the slot is free, the request will block until someone uploads an answer to the same slot, at which point it will return the answer.
<p>If the body is an offer and the slot is busy, the response will be the original offer.
<p>If the body is an answer, it will be forwarded to the original sender of the offer.
<p>All other requests are invalid.</p>

<h2>USAGE EXAMPLE</h2>
<p>Here's some example JavaScript to demostrate the usage of the API. The dial() function returns an RTCPeerConnection object.</p>
<pre>
let dial = async (slot, config) => {
	let initconn = pc => {
		// Initialise a PeerConnection as you need, e.g. by adding streams
		// or data channels. Here we add a data channel and assign it to
		// the global variable dc.
		dc = pc.createDataChannel("data", {negotiated: true, id: 0});
		let decoder = new TextDecoder(); // default utf8
		dc.onmessage = (e) => {
			console.log(decoder.decode(new Uint8Array(e.data)));
		}
	}
	let pc = new RTCPeerConnection(config);
	initconn(pc);
	await pc.setLocalDescription(await pc.createOffer()) // Create an offer.
	// Wait for ICE candidates.
	await new Promise(r=>{pc.onicecandidate=e=>{if(e.candidate === null){r()}}})
	// Upload offer.
	let response = await fetch("https://example.com/"+slot, {
		method: 'POST',
		body: JSON.stringify(pc.localDescription)
	})
	let remote = await response.json();
	if (remote["type"] === "offer") {
		// We got back another offer, which means someone else (possibly
		// the party we're trying to reach) beat us to this slot.
		// Throw away our offer and accept this one, creating an answer.
		pc = new RTCPeerConnection(config);
		initconn(pc);
		// await pc.setLocalDescription({"type":"rollback"}); // Firefox only
		await pc.setRemoteDescription(new RTCSessionDescription(remote));
		await pc.setLocalDescription(await pc.createAnswer());
		// Wait for ICE candidates.
		await new Promise(r=>{pc.onicecandidate=e=>{if(e.candidate === null){r()}}})

		// Upload answer.
		await fetch("https://example.com/"+slot, {
			method: 'POST',
			body: JSON.stringify(pc.localDescription)
		})
	} else if (remote["type"] === "answer") {
		// We got back an answer to our offer. Accept it.
		await pc.setRemoteDescription(new RTCSessionDescription(remote));
	}
	return pc
}
</pre>

<h2>SECURITY CONSIDIRATIONS</h2>
<p>On its own, this scheme is not secure.</p>
<p>In the best case, assuming the slot name is a long and difficult to guess string, the trust model would still have to include the operator of the signalling server, since they can see and potentially modify both parties' SDPs.</p>
<p>For a demo that might be good enough, but for any useful application you'll need to implement a way for A to authenticate B on this potentially untrusted link. Some PAKE might be a good way to do it and fits well with the slot system. Again, cf. Magic Wormhole.</p>

<h2>LIMITATIONS</h2>
<p>There is no support for <a href="https://tools.ietf.org/html/draft-ietf-ice-trickle-21">Trickle ICE</a>. The offer and answer must have all candidates to be considered.</p>

<h2>DISCLAIMER</h2>
<p>The authors offer an instance of this service hosted at https://minimumsignal.0f.io/. The authors takes absolutely no responsibity and offers no promises for the reliability or availability of this experiment.</p>
<p>We reserve the right to call quits any time. If Google can do this we sure can.</p>

<footer>
Comments &amp; complaints <a href="https://0x65.net" rel="author">salman aljammaz</a>: <a href="https://twitter.com/_saljam">@_saljam</a> or <a href="mailto:s@aljmz.com">s@aljmz.com</a>
</footer>
`
