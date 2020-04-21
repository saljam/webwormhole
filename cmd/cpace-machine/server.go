package main

// This is the signalling server. It holds messages between peers wishing to connect.

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

const (
	maxSlotLength    = 125
	maxMessageLength = 10 << 10
)

type slot struct {
	msg    []byte
	answer chan []byte
	id     string
}

var slots = struct {
	m map[string]*slot
	sync.RWMutex
}{m: make(map[string]*slot)}

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
	// Give up.
	return "", false
}

var fs http.Handler

func serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "PUT, POST, DELETE")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-Match")
	w.Header().Set("Access-Control-Expose-Headers", "Etag, Location")
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()

	if r.Method == http.MethodGet &&
		(r.URL.Path == "/" ||
			strings.HasSuffix(r.URL.Path, ".html") ||
			strings.HasSuffix(r.URL.Path, ".css") ||
			strings.HasSuffix(r.URL.Path, ".js") ||
			strings.HasSuffix(r.URL.Path, ".wasm")) {
		fs.ServeHTTP(w, r)
		return
	}

	if r.Method == http.MethodOptions {
		return
	}

	slotkey := strings.TrimPrefix(r.URL.Path, "/")
	msg, err := ioutil.ReadAll(&io.LimitedReader{
		R: r.Body,
		N: maxMessageLength,
	})
	if err != nil {
		http.Error(w, "could not read body", http.StatusBadRequest)
		return
	}
	if len(slotkey) > maxSlotLength || strings.Contains(slotkey, "/") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if r.Method == http.MethodPost && slotkey != "" {
		http.Error(w, "not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodPut &&
		r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "not allowed", http.StatusMethodNotAllowed)
		return
	}

	slots.Lock()
	if slotkey == "" && r.Method == http.MethodPost {
		var ok bool
		slotkey, ok = freeslot()
		if !ok {
			slots.Unlock()
			http.Error(w, "couldn't find an available slot", http.StatusServiceUnavailable)
			return
		}
		r.URL.Path = "/" + slotkey
		// TODO remember uploaded content-type and set it here.
		w.Header().Set("Location", r.URL.String())
	}
	s := slots.m[slotkey]
	switch {
	case s == nil && r.Header.Get("If-Match") == "":
		// This is a new conversation.
		if r.Method == http.MethodGet {
			http.Error(w, "nothing at this slot", http.StatusNotFound)
			slots.Unlock()
			return
		}
		s = &slot{msg: msg, answer: make(chan []byte), id: strconv.Itoa(rand.Int())}
		slots.m[slotkey] = s
		slots.Unlock()
		// Set tag and flush, so the client can get the headers including the assigned slot.
		w.Header().Set("ETag", s.id)
		w.WriteHeader(http.StatusOK)
		// Firefox fetch() promise does not resolve unless one byte of the body has been written.
		// Is there a header to contol this? Chrome does not need this.
		w.Write([]byte("\n"))
		w.(http.Flusher).Flush()
		log.Printf("start %v %v", slotkey, s.id)
		select {
		case a := <-s.answer:
			log.Printf("answered %v %v", slotkey, s.id)
			_, err := w.Write(a)
			if err != nil {
				log.Printf("%v", err)
			}
		case <-ctx.Done():
			log.Printf("timeout %v %v", slotkey, s.id)
			slots.Lock()
			delete(slots.m, slotkey)
			slots.Unlock()
		}
	case s != nil && r.Header.Get("If-Match") == "":
		// Already have something in the slot, pass that down.
		slots.Unlock()
		w.Header().Set("ETag", s.id)
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusPreconditionRequired)
		}
		_, err := w.Write(s.msg)
		if err != nil {
			log.Printf("%v", err)
		}
	case s != nil && r.Header.Get("If-Match") == s.id:
		// This is an answer, wake the other go routines up.
		// TODO optimisation: after receiving the first of these, we can use s.id
		// to match the messages and free the slot early. Would need another index
		// to map ids to "sessions".
		slots.Unlock()
		w.Header().Set("ETag", s.id)
		select {
		case s.answer <- msg:
		case <-ctx.Done():
			log.Printf("timeout %v %v", slotkey, s.id)
			slots.Lock()
			delete(slots.m, slotkey)
			slots.Unlock()
		}
		if r.Method == http.MethodDelete {
			log.Printf("end %v %v", slotkey, s.id)
			slots.Lock()
			delete(slots.m, slotkey)
			slots.Unlock()
			return
		}
		select {
		case a := <-s.answer:
			log.Printf("answered %v %v", slotkey, s.id)
			_, err := w.Write(a)
			if err != nil {
				log.Printf("%v", err)
			}
		case <-ctx.Done():
			log.Printf("timeout %v %v", slotkey, s.id)
			slots.Lock()
			delete(slots.m, slotkey)
			slots.Unlock()
		}
	default:
		// Empty slot + some If-Match. Bad request If-Match or slot timed out.
		slots.Unlock()
		http.Error(w, "nothing at this slot", http.StatusConflict)
	}
}

func server(args ...string) {
	rand.Seed(time.Now().UnixNano())
	set := flag.NewFlagSet(args[0], flag.ExitOnError)
	set.Usage = func() {
		fmt.Fprintf(set.Output(), "run the cpace-machine signalling server\n\n")
		fmt.Fprintf(set.Output(), "usage: %s %s\n\n", os.Args[0], args[0])
		fmt.Fprintf(set.Output(), "flags:\n")
		set.PrintDefaults()
	}
	httpaddr := set.String("http", ":http", "http listen address")
	httpsaddr := set.String("https", ":https", "https listen address")
	whitelist := set.String("hosts", ":https", "comma separated list of hosts for which to request let's encrypt certs")
	secretpath := set.String("secrets", os.Getenv("HOME")+"/keys", "path to put let's encrypt cache")
	html := set.String("ui", "/lib/cpace-machine/web", "path to the web interface files")
	set.Parse(args[1:])

	fs = http.FileServer(http.Dir(*html))

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
		Handler:      http.HandlerFunc(serveHTTP),
		TLSConfig:    &tls.Config{GetCertificate: m.GetCertificate},
	}
	srv := &http.Server{
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Minute,
		IdleTimeout:  20 * time.Second,
		Addr:         *httpaddr,
		Handler:      m.HTTPHandler(http.HandlerFunc(serveHTTP)),
	}

	if *httpsaddr != "" {
		srv.Handler = m.HTTPHandler(nil) // Enable redirect to https handler.
		go func() { log.Fatal(ssrv.ListenAndServeTLS("", "")) }()
	}
	log.Fatal(srv.ListenAndServe())
}
