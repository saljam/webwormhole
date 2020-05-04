package main

// This is the signalling server. It relays messages between peers wishing to connect.

import (
	"context"
	"crypto/tls"
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

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/acme/autocert"
)

// slots is a map of allocated slot numbers.
var slots = struct {
	m map[string]chan *websocket.Conn
	sync.RWMutex
}{m: make(map[string]chan *websocket.Conn)}

const importMeta = `<doctype html>
<meta name="go-import" content="webwormhole.io git https://github.com/saljam/webwormhole">
<meta http-equiv="refresh" content="0;URL='https://github.com/saljam/webwormhole'">
`

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

// upgrader is a used to start WebSocket connections.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1 << 10,
	WriteBufferSize: 1 << 10,
}

// relay sets up a rendezvous on a slot and pipes the two websockets together.
func relay(w http.ResponseWriter, r *http.Request) {
	slotkey := r.URL.Path[len("/s/"):]
	var rconn *websocket.Conn
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)

	go func() {
		if slotkey == "" {
			// Book a new slot.
			slots.Lock()
			newslot, ok := freeslot()
			if !ok {
				slots.Unlock()
				conn.WriteControl(
					websocket.CloseNormalClosure,
					websocket.FormatCloseMessage(http.StatusServiceUnavailable, "can't allocate slots"),
					time.Now().Add(10*time.Second),
				)
				return
			}
			slotkey = newslot
			sc := make(chan *websocket.Conn)
			slots.m[slotkey] = sc
			slots.Unlock()
			log.Printf("%s book", slotkey)
			err = conn.WriteMessage(websocket.TextMessage, []byte(slotkey))
			if err != nil {
				log.Println(err)
				return
			}
			select {
			case <-ctx.Done():
				log.Printf("%s timeout", slotkey)
				slots.Lock()
				delete(slots.m, slotkey)
				slots.Unlock()
				conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(http.StatusRequestTimeout, "timed out"),
					time.Now().Add(10*time.Second),
				)
				return
			case sc <- conn:
			}
			rconn = <-sc
			log.Printf("%s rendezvous", slotkey)
			return
		}
		// Join an existing slot.
		slots.Lock()
		sc, ok := slots.m[slotkey]
		if !ok {
			slots.Unlock()
			conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(http.StatusNotFound, "no such slot"),
				time.Now().Add(10*time.Second),
			)
			return
		}
		delete(slots.m, slotkey)
		slots.Unlock()
		log.Printf("%s visit", slotkey)
		select {
		case <-ctx.Done():
			conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(http.StatusRequestTimeout, "timed out"),
				time.Now().Add(10*time.Second),
			)
		case rconn = <-sc:
		}
		sc <- conn
	}()

	defer cancel()
	for {
		messageType, p, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if rconn == nil {
			// We could synchronise with the rendezvous goroutine above and wait for
			// B to connect, but receiving anything at this stage is a protocol violation
			// so we should just bail out.
			return
		}
		err = rconn.WriteMessage(messageType, p)
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
	set.Parse(args[1:])

	fs := http.FileServer(http.Dir(*html))
	mux := http.NewServeMux()
	mux.HandleFunc("/s/", relay)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("go-get") == "1" || r.URL.Path == "/cmd/ww" {
			w.Write([]byte(importMeta))
			return
		}
		fs.ServeHTTP(w, r)
	})

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
		Handler:      mux,
		TLSConfig:    &tls.Config{GetCertificate: m.GetCertificate},
	}
	srv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Minute,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpaddr,
		Handler:      m.HTTPHandler(mux),
	}

	if *httpsaddr != "" {
		srv.Handler = m.HTTPHandler(nil) // Enable redirect to https handler.
		go func() { log.Fatal(ssrv.ListenAndServeTLS("", "")) }()
	}
	log.Fatal(srv.ListenAndServe())
}
