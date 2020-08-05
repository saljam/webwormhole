package main

// This is the signalling server. It relays messages between peers wishing to connect.

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"expvar"
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
	webrtc "github.com/pion/webrtc/v2"
	"golang.org/x/crypto/acme/autocert"
	"nhooyr.io/websocket"
	"webwormhole.io/wormhole"
)

// slotTimeout is the the maximum amount of time a client is allowed to
// hold a slot.
const slotTimeout = 30 * time.Minute

const importMeta = `<!doctype html>
<meta charset=utf-8>
<meta name="go-import" content="webwormhole.io git https://github.com/saljam/webwormhole">
<meta http-equiv="refresh" content="0;URL='https://github.com/saljam/webwormhole'">
`

const serviceWorkerPage = `Oops. You're not supposed to end up here.

This URL is used by WebWormhole to efficiently download data from
a web page.  It is usually handled by a ServiceWorker running in
your browser.
`

var stats = struct {
	timeout          *expvar.Int
	rendezvous       *expvar.Int
	serviceworkererr *expvar.Int
	goget            *expvar.Int
	nosuchslot       *expvar.Int
	nomoreslots      *expvar.Int
	usedslots        *expvar.Int
	badproto         *expvar.Int
}{
	timeout:          expvar.NewInt("timeout"),
	rendezvous:       expvar.NewInt("rendezvous"),
	serviceworkererr: expvar.NewInt("serviceworkererr"),
	goget:            expvar.NewInt("goget"),
	nosuchslot:       expvar.NewInt("nosuchslot"),
	nomoreslots:      expvar.NewInt("nomoreslots"),
	usedslots:        expvar.NewInt("usedslots"),
	badproto:         expvar.NewInt("badproto"),
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
	// Try a single decimal digit number.
	for i := 0; i < 3; i++ {
		s := strconv.Itoa(rand.Intn(10))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Try a single byte number.
	for i := 0; i < 64; i++ {
		s := strconv.Itoa(rand.Intn(1 << 8))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Try a 2-byte number.
	for i := 0; i < 1024; i++ {
		s := strconv.Itoa(rand.Intn(1 << 16))
		if _, ok := slots.m[s]; !ok {
			return s, true
		}
	}
	// Try a 3-byte number.
	for i := 0; i < 1024; i++ {
		s := strconv.Itoa(rand.Intn(1 << 24))
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
		stats.badproto.Add(1)
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
				stats.nomoreslots.Add(1)
				conn.Close(wormhole.CloseNoMoreSlots, "cannot allocate slots")
				return
			}
			slotkey = newslot
			sc := make(chan *websocket.Conn)
			slots.m[slotkey] = sc
			stats.usedslots.Set(int64(len(slots.m)))
			slots.Unlock()
			initmsg.Slot = slotkey
			buf, err := json.Marshal(initmsg)
			if err != nil {
				log.Println(err)
				slots.Lock()
				delete(slots.m, slotkey)
				stats.usedslots.Set(int64(len(slots.m)))
				slots.Unlock()
				return
			}
			err = conn.Write(ctx, websocket.MessageText, buf)
			if err != nil {
				log.Println(err)
				slots.Lock()
				delete(slots.m, slotkey)
				stats.usedslots.Set(int64(len(slots.m)))
				slots.Unlock()
				return
			}
			select {
			case <-ctx.Done():
				stats.timeout.Add(1)
				slots.Lock()
				delete(slots.m, slotkey)
				stats.usedslots.Set(int64(len(slots.m)))
				slots.Unlock()
				conn.Close(wormhole.CloseSlotTimedOut, "timed out")
				return
			case sc <- conn:
			}
			rconn = <-sc
			stats.rendezvous.Add(1)
			return
		}
		// Join an existing slot.
		slots.Lock()
		sc, ok := slots.m[slotkey]
		if !ok {
			slots.Unlock()
			stats.nosuchslot.Add(1)
			conn.Close(wormhole.CloseNoSuchSlot, "no such slot")
			return
		}
		delete(slots.m, slotkey)
		stats.usedslots.Set(int64(len(slots.m)))
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
	}()

	defer cancel()
	for {
		msgType, p, err := conn.Read(ctx)
		if websocket.CloseStatus(err) == wormhole.CloseBadKey {
			if rconn != nil {
				rconn.Close(wormhole.CloseBadKey, "bad key")
			}
			return
		}
		if err != nil {
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
	rand.Seed(time.Now().UnixNano())

	set := flag.NewFlagSet(args[0], flag.ExitOnError)
	set.Usage = func() {
		fmt.Fprintf(set.Output(), "run the webwormhole signalling server\n\n")
		fmt.Fprintf(set.Output(), "usage: %s %s\n\n", os.Args[0], args[0])
		fmt.Fprintf(set.Output(), "flags:\n")
		set.PrintDefaults()
	}
	httpaddr := set.String("http", ":http", "http listen address")
	httpsaddr := set.String("https", ":https", "https listen address")
	whitelist := set.String("hosts", "", "comma separated list of hosts for which to request let's encrypt certs")
	secretpath := set.String("secrets", os.Getenv("HOME")+"/keys", "path to put let's encrypt cache")
	html := set.String("ui", "./web", "path to the web interface files")
	stunservers := set.String("stun", "stun:relay.webwormhole.io", "list of STUN server addresses to tell clients to use")
	set.StringVar(&turnServer, "turn", "", "TURN server to use for relaying")
	set.StringVar(&turnSecret, "turn-secret", "", "secret for HMAC-based authentication in TURN server")
	set.Parse(args[1:])

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
		if strings.HasPrefix(r.URL.Path, "/s/") {
			http.Error(w, "old protocol version please upgrade client", http.StatusNotFound)
			return
		}
		if strings.ToLower(r.Header.Get("Upgrade")) == "websocket" {
			relay(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*") // to allow loading js modules
		if r.URL.Query().Get("go-get") == "1" || r.URL.Path == "/cmd/ww" {
			stats.goget.Add(1)
			w.Write([]byte(importMeta))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/_/") {
			stats.serviceworkererr.Add(1)
			http.Error(w, serviceWorkerPage, http.StatusNotFound)
			return
		}
		fs.ServeHTTP(w, r)
	}

	m := &autocert.Manager{
		Cache:      autocert.DirCache(*secretpath),
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(strings.Split(*whitelist, ",")...),
	}
	ssrv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Minute,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpsaddr,
		Handler:      http.HandlerFunc(handler),
		TLSConfig:    &tls.Config{GetCertificate: m.GetCertificate},
	}
	srv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Minute,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpaddr,
		Handler:      m.HTTPHandler(http.HandlerFunc(handler)),
	}

	if *httpsaddr != "" {
		srv.Handler = m.HTTPHandler(nil) // Enable redirect to https handler.
		go func() { log.Fatal(ssrv.ListenAndServeTLS("", "")) }()
	}
	log.Fatal(srv.ListenAndServe())
}
