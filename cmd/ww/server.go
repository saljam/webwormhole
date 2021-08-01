package main

// This is the signalling server. It relays messages between peers wishing to connect.

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NYTimes/gziphandler"
	webrtc "github.com/pion/webrtc/v3"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/crypto/acme/autocert"
	"nhooyr.io/websocket"
	"webwormhole.io/wormhole"
)

// slotTimeout is the the maximum amount of time a client is allowed to
// hold a slot.
const slotTimeout = 12 * time.Hour

const importMeta = `<!doctype html>
<meta charset=utf-8>
<meta name="go-import" content="webwormhole.io git https://github.com/saljam/webwormhole">
<meta http-equiv="refresh" content="0;URL='https://github.com/saljam/webwormhole'">
`

const serviceWorkerPage = `You're not supposed to get this file or end up here.

This is a dummy URL is used by WebWormhole to help web browsers
efficiently download files from a WebRTC connection. It should be
handled entirely by a ServiceWorker running in your browser.

If you got this text instead of the file you expected to download,
it is possible your web browser doesn't fully support ServiceWorkers
but claims it does. Try a different web browser, and if that doesn't
work, please file a bug report.
`

var (
	rendezvousCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "ww",
			Name:      "rendezvous_attempts",
			Help:      "Number of attempts to rendezvous using the signalling server.",
		},
		[]string{"result"},
	)
	iceCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "ww",
			Name:      "webrtc_attempts",
			Help:      "Number of reported ICE results sliced by ICE method used.",
		},
		[]string{"result", "method"},
	)
	protocolErrorCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "ww",
			Name:      "protocol_errors",
			Help:      "Number of bad requests to the signalling server.",
		},
		[]string{"kind"},
	)
	slotsGuage = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Namespace: "ww",
			Name:      "busy_slots",
			Help:      "Number of currently busy slots.",
		},
	)
)

func init() {
	prometheus.MustRegister(rendezvousCounter)
	prometheus.MustRegister(iceCounter)
	prometheus.MustRegister(protocolErrorCounter)
	prometheus.MustRegister(slotsGuage)
}

// slots is a map of allocated slot numbers.
var slots = struct {
	m map[string]chan *websocket.Conn
	sync.RWMutex
}{m: make(map[string]chan *websocket.Conn)}

// turnSecret, turnServer, and stunServers are used to generate ICE config
// and send it to clients as soon as they connect.
var turnSecret string
var turnServer string
var stunServers []webrtc.ICEServer

// freeslot tries to find an available numeric slot, favouring smaller numbers.
// This assume slots is locked.
func freeslot() (slot string, ok bool) {
	// Assuming varint encoding, we first try for one byte. That's 7 bits in varint.
	for i := 0; i < 64; i++ {
		s := strconv.Itoa(rand.Intn(1 << 7))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Then try for two bytes. 11 bits.
	for i := 0; i < 1024; i++ {
		s := strconv.Itoa(rand.Intn(1 << 11))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Then try for three bytes. 16 bits.
	for i := 0; i < 2048; i++ {
		s := strconv.Itoa(rand.Intn(1 << 16))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Then try for four bytes. 21 bits.
	for i := 0; i < 2048; i++ {
		s := strconv.Itoa(rand.Intn(1 << 21))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Give up.
	return "", false
}

// turnServers return the configured TURN server with HMAC-based ephemeral
// credentials generated as described in:
// https://tools.ietf.org/html/draft-uberti-behave-turn-rest-00
func turnServers() []webrtc.ICEServer {
	if turnServer == "" {
		return nil
	}
	username := fmt.Sprintf("%d:wormhole", time.Now().Add(slotTimeout).Unix())
	mac := hmac.New(sha1.New, []byte(turnSecret))
	mac.Write([]byte(username))
	return []webrtc.ICEServer{{
		URLs:       []string{turnServer},
		Username:   username,
		Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
	}}
}

// relay sets up a rendezvous on a slot and pipes the two websockets together.
func relay(w http.ResponseWriter, r *http.Request) {
	slotkey := r.URL.Path[1:] // strip leading slash
	var rconn *websocket.Conn
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// This sounds nasty but checking origin only matters if requests
		// change any user state on the server, aka CSRF. We don't have any
		// user state other than this ephemeral connection. So it's fine.
		InsecureSkipVerify: true,
		Subprotocols:       []string{wormhole.Protocol},
	})
	if err != nil {
		log.Println(err)
		return
	}
	if conn.Subprotocol() != wormhole.Protocol {
		// Make sure we negotiated the right protocol, since "blank" is also a
		// default one.
		protocolErrorCounter.WithLabelValues("wrongversion").Inc()
		conn.Close(wormhole.CloseWrongProto, "wrong protocol, please upgrade client")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), slotTimeout)

	initmsg := struct {
		Slot       string             `json:"slot",omitempty`
		ICEServers []webrtc.ICEServer `json:"iceServers",omitempty`
	}{}
	initmsg.ICEServers = append(turnServers(), stunServers...)

	go func() {
		if slotkey == "" {
			// Book a new slot.
			slots.Lock()
			newslot, ok := freeslot()
			if !ok {
				slots.Unlock()
				rendezvousCounter.WithLabelValues("nomoreslots").Inc()
				conn.Close(wormhole.CloseNoMoreSlots, "cannot allocate slots")
				return
			}
			slotkey = newslot
			sc := make(chan *websocket.Conn)
			slots.m[slotkey] = sc
			slotsGuage.Set(float64(len(slots.m)))
			slots.Unlock()
			initmsg.Slot = slotkey
			buf, err := json.Marshal(initmsg)
			if err != nil {
				log.Println(err)
				slots.Lock()
				delete(slots.m, slotkey)
				slotsGuage.Set(float64(len(slots.m)))
				slots.Unlock()
				return
			}
			err = conn.Write(ctx, websocket.MessageText, buf)
			if err != nil {
				log.Println(err)
				slots.Lock()
				delete(slots.m, slotkey)
				slotsGuage.Set(float64(len(slots.m)))
				slots.Unlock()
				return
			}

		wait:
			for {
				select {
				case <-ctx.Done():
					rendezvousCounter.WithLabelValues("timeout").Inc()
					slots.Lock()
					delete(slots.m, slotkey)
					slotsGuage.Set(float64(len(slots.m)))
					slots.Unlock()
					conn.Close(wormhole.CloseSlotTimedOut, "timed out")
					return
				case <-time.After(30 * time.Second):
					// Do a WebSocket Ping every 30 seconds.
					conn.Ping(ctx)
				case sc <- conn:
					break wait
				}
			}
			rconn = <-sc
			rendezvousCounter.WithLabelValues("success").Inc()
			return
		}

		// Join an existing slot.
		slots.Lock()
		sc, ok := slots.m[slotkey]
		if !ok {
			slots.Unlock()
			rendezvousCounter.WithLabelValues("nosuchslot").Inc()
			conn.Close(wormhole.CloseNoSuchSlot, "no such slot")
			return
		}
		delete(slots.m, slotkey)
		slotsGuage.Set(float64(len(slots.m)))
		slots.Unlock()
		initmsg.Slot = slotkey
		buf, err := json.Marshal(initmsg)
		if err != nil {
			log.Println(err)
			return
		}
		err = conn.Write(ctx, websocket.MessageText, buf)
		if err != nil {
			log.Println(err)
			return
		}
		select {
		case <-ctx.Done():
			conn.Close(wormhole.CloseSlotTimedOut, "timed out")
		case rconn = <-sc:
		}
		sc <- conn
		rendezvousCounter.WithLabelValues("success").Inc()
	}()

	defer cancel()
	for {
		msgType, p, err := conn.Read(ctx)
		switch websocket.CloseStatus(err) {
		case wormhole.CloseBadKey:
			iceCounter.WithLabelValues("fail", "badkey").Inc()
			if rconn != nil {
				rconn.Close(wormhole.CloseBadKey, "bad key")
			}
			return
		case wormhole.CloseWebRTCFailed:
			iceCounter.WithLabelValues("fail", "unknown").Inc()
			return
		case wormhole.CloseWebRTCSuccess:
			iceCounter.WithLabelValues("success", "unknown").Inc()
			return
		case wormhole.CloseWebRTCSuccessDirect:
			iceCounter.WithLabelValues("success", "direct").Inc()
			return
		case wormhole.CloseWebRTCSuccessRelay:
			iceCounter.WithLabelValues("success", "relay").Inc()
			return
		}
		if err != nil {
			iceCounter.WithLabelValues("unknown", "unknown").Inc()
			if rconn != nil {
				rconn.Close(wormhole.ClosePeerHungUp, "peer hung up")
			}
			return
		}
		if rconn == nil {
			// We could synchronise with the rendezvous goroutine above and wait for
			// B to connect, but receiving anything at this stage is a protocol violation
			// so we should just bail out.
			return
		}
		err = rconn.Write(ctx, msgType, p)
		if err != nil {
			return
		}
	}
}

func server(args ...string) {
	rand.Seed(time.Now().UnixNano()) // for slot allocation

	set := flag.NewFlagSet(args[0], flag.ExitOnError)
	set.Usage = func() {
		fmt.Fprintf(set.Output(), "run the webwormhole signalling server\n\n")
		fmt.Fprintf(set.Output(), "usage: %s %s\n\n", os.Args[0], args[0])
		fmt.Fprintf(set.Output(), "flags:\n")
		set.PrintDefaults()
	}
	httpaddr := set.String("http", ":http", "http listen address")
	httpsaddr := set.String("https", ":https", "https listen address")
	debugaddr := set.String("debug", "", "debug and metrics listen address")
	hosts := set.String("hosts", "", "comma separated list of hosts by which site is accessible")
	secretpath := set.String("secrets", os.Getenv("HOME")+"/keys", "path to put let's encrypt cache")
	cert := set.String("cert", "", "https certificate (leave empty to use letsencrypt)")
	key := set.String("key", "", "https certificate key")
	html := set.String("ui", "./web", "path to the web interface files")
	stunservers := set.String("stun", "stun:relay.webwormhole.io", "list of STUN server addresses to tell clients to use")
	set.StringVar(&turnServer, "turn", "", "TURN server to use for relaying")
	set.StringVar(&turnSecret, "turn-secret", "", "secret for HMAC-based authentication in TURN server")
	set.Parse(args[1:])

	if (*cert == "") != (*key == "") {
		log.Fatalf("-cert and -key options must be provided together or both left empty")
	}

	if turnServer != "" && turnSecret == "" {
		log.Fatal("cannot use a TURN server without a secret")
	}

	for _, s := range strings.Split(*stunservers, ",") {
		if s == "" {
			continue
		}
		stunServers = append(stunServers, webrtc.ICEServer{URLs: []string{s}})
	}

	fs := gziphandler.GzipHandler(http.FileServer(http.Dir(*html)))
	handler := func(w http.ResponseWriter, r *http.Request) {
		// Handle WebSocket connections.
		if strings.ToLower(r.Header.Get("Upgrade")) == "websocket" {
			relay(w, r)
			return
		}

		// Allow 3rd parties to load JS modules, etc.
		w.Header().Set("Access-Control-Allow-Origin", "*")

		// Disallow 3rd party code to run when we're the origin.
		// unsafe-eval is required for wasm :(
		// https://github.com/WebAssembly/content-security-policy/issues/7
		// connect-src is required for safari :(
		// https://bugs.webkit.org/show_bug.cgi?id=201591
		csp := "default-src 'self'; script-src 'self' 'unsafe-eval'; img-src 'self' blob:; connect-src 'self' ws://localhost/"
		for _, host := range strings.Split(*hosts, ",") {
			csp += fmt.Sprintf(" wss://%v", host)
		}
		w.Header().Set("Content-Security-Policy", csp)

		// Set a small max age for cache. We might want to switch to a content-addressed
		// resource naming scheme and change this to immutable, but until then disable caching.
		w.Header().Set("Cache-Control", "no-cache")

		// Set HSTS header for 2 years on HTTPS connections.
		if *httpsaddr != "" {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000")
		}

		// Return a redirect to source code repo for the go get URL.
		if r.URL.Query().Get("go-get") == "1" || r.URL.Path == "/cmd/ww" {
			w.Write([]byte(importMeta))
			return
		}

		// Handle the Service Worker private prefix. A well-behaved Service Worker
		// must *never* reach us on this path.
		if strings.HasPrefix(r.URL.Path, "/_/") {
			protocolErrorCounter.WithLabelValues("serviceworkererr").Inc()
			http.Error(w, serviceWorkerPage, http.StatusNotFound)
			return
		}

		fs.ServeHTTP(w, r)
	}

	m := &autocert.Manager{
		Cache:      autocert.DirCache(*secretpath),
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(strings.Split(*hosts, ",")...),
	}

	ssrv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Minute,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpsaddr,
		Handler:      http.HandlerFunc(handler),
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			CipherSuites: []uint16{
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
				tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
			},
		},
	}
	srv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Minute,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpaddr,
		Handler:      m.HTTPHandler(http.HandlerFunc(handler)),
	}

	if *cert == "" && *key == "" {
		ssrv.TLSConfig.GetCertificate = m.GetCertificate
	}

	errc := make(chan error)
	if *debugaddr != "" {
		http.Handle("/metrics", promhttp.Handler())
		go func() { errc <- http.ListenAndServe(*debugaddr, nil) }()
	}
	if *httpsaddr != "" {
		srv.Handler = m.HTTPHandler(nil) // Enable redirect to https handler.
		go func() { errc <- ssrv.ListenAndServeTLS(*cert, *key) }()
	}
	if *httpaddr != "" {
		go func() { errc <- srv.ListenAndServe() }()
	}
	log.Fatal(<-errc)
}
