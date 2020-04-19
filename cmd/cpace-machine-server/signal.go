// Command cpace-machine-server is a WebRTC signalling server.
//
// It facilitates establishing WebRTC connections between peers using ephemeral
// slots to hold WebRTC offers and answers.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
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

func serveHTTP(w http.ResponseWriter, r *http.Request) {
	slotkey := strings.TrimPrefix(r.URL.Path, "/")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "PUT, POST, DELETE")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-Match")
	w.Header().Set("Access-Control-Expose-Headers", "Etag, Location")
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

	log.Printf("%v: %v", slotkey, r.Method)

	switch r.Method {
	case http.MethodGet:
		if slotkey != "" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Write([]byte(indexpage))
	case http.MethodOptions:
	case http.MethodPost:
		if slotkey != "" {
			http.Error(w, "not found", http.StatusMethodNotAllowed)
			return
		}
		fallthrough
	case http.MethodPut, http.MethodDelete:
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
			select {
			case a := <-s.answer:
				_, err := w.Write(a)
				if err != nil {
					log.Printf("%v", err)
				}
			case <-r.Context().Done():
				slots.Lock()
				delete(slots.m, slotkey)
				slots.Unlock()
			}
		case s != nil && r.Header.Get("If-Match") == "":
			// Already have something in the slot, pass that down.
			slots.Unlock()
			w.Header().Set("ETag", s.id)
			w.WriteHeader(http.StatusPreconditionRequired)
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
			case <-r.Context().Done():
				slots.Lock()
				delete(slots.m, slotkey)
				slots.Unlock()
			}
			if r.Method == http.MethodDelete {
				slots.Lock()
				delete(slots.m, slotkey)
				slots.Unlock()
				return
			}
			select {
			case a := <-s.answer:
				_, err := w.Write(a)
				if err != nil {
					log.Printf("%v", err)
				}
			case <-r.Context().Done():
				slots.Lock()
				delete(slots.m, slotkey)
				slots.Unlock()
			}
		default:
			// Empty slot + some If-Match. Bad request If-Match or slot timed out.
			slots.Unlock()
			http.Error(w, "nothing at this slot", http.StatusConflict)
		}
	default:
		http.Error(w, "invalid method", http.StatusMethodNotAllowed)
	}
}

func main() {
	rand.Seed(time.Now().UnixNano())
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
