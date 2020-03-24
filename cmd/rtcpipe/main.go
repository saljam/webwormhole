package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/pion/webrtc/v2"
)

var (
	webRTCConfig = webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	}
	signallingServer = "https://minimumsignal.0f.io/"
)

// conn is a wrapper around webrtc.DataChannel that implements blocked Read/Write.
type conn struct {
	rwc io.ReadWriteCloser
	d   *webrtc.DataChannel
	pc  *webrtc.PeerConnection

	// opened signals that the underlying DataChannel is open and ready
	// to handle data.
	opened chan struct{}
	// err forwards errors from the OnError callback.
	err chan error

	// flushc is a condition variable to coordinate flushed state of the
	// underlying channel.
	flushc *sync.Cond
}

func (c *conn) open() {
	var err error
	c.rwc, err = c.d.Detach()
	if err != nil {
		log.Printf("could not detatch data channel: %v", err)
	}
	close(c.opened)
}

func (c *conn) error(err error) {
	log.Printf("debug: %v", err)
	c.err <- err
}

func (c *conn) flushed() {
	log.Printf("debug: flush")
	c.flushc.L.Lock()
	c.flushc.Broadcast()
	c.flushc.L.Unlock()
}

// dial connects to a the WebRTC peer on slot, and returns WebRTC data channel to it.
func dial(slot string) (*conn, error) {
	// Accessing APIs like DataChannel.Detach() requires that we do this voodoo.
	s := webrtc.SettingEngine{}
	s.DetachDataChannels()
	rtcapi := webrtc.NewAPI(webrtc.WithSettingEngine(s))

	c := &conn{
		opened: make(chan struct{}),
		err:    make(chan error),
		flushc: sync.NewCond(&sync.Mutex{}),
	}

	dataChannelConfig := &webrtc.DataChannelInit{
		Negotiated: new(bool),
		ID:         new(uint16),
	}
	*dataChannelConfig.Negotiated = true

	var err error
	c.pc, err = rtcapi.NewPeerConnection(webRTCConfig)
	if err != nil {
		return nil, err
	}
	c.d, err = c.pc.CreateDataChannel("data", dataChannelConfig)
	if err != nil {
		return nil, err
	}
	c.d.OnOpen(c.open)
	c.d.OnError(c.error)
	c.d.OnBufferedAmountLow(c.flushed)

	offer, err := c.pc.CreateOffer(nil)
	if err != nil {
		return nil, err
	}
	err = c.pc.SetLocalDescription(offer)
	if err != nil {
		return nil, err
	}
	o, err := json.Marshal(offer)
	if err != nil {
		return nil, err
	}
	log.Printf("sending offer")
	res, err := http.Post(signallingServer+slot, "application/json", bytes.NewReader(o))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		log.Fatal("not okay")
	}
	var remote webrtc.SessionDescription
	err = json.NewDecoder(res.Body).Decode(&remote)
	if err != nil {
		return nil, err
	}
	switch remote.Type {
	case webrtc.SDPTypeOffer:
		// The webrtc package does not support rollback. Make a new PeerConnection object.
		//err := pc.SetLocalDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeRollback})
		c.pc, err = rtcapi.NewPeerConnection(webRTCConfig)
		if err != nil {
			return nil, err
		}
		c.d, err = c.pc.CreateDataChannel("data", dataChannelConfig)
		if err != nil {
			return nil, err
		}
		c.d.OnOpen(c.open)
		c.d.OnError(c.error)
		c.d.OnBufferedAmountLow(c.flushed)

		err = c.pc.SetRemoteDescription(remote)
		if err != nil {
			return nil, err
		}
		answer, err := c.pc.CreateAnswer(nil)
		if err != nil {
			return nil, err
		}
		err = c.pc.SetLocalDescription(answer)
		if err != nil {
			return nil, err
		}
		a, err := json.Marshal(answer)
		if err != nil {
			return nil, err
		}
		res, err := http.Post(signallingServer+slot, "application/json", bytes.NewReader(a))
		if err != nil {
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("signalling server returned status %v", res.Status)
		}

		log.Printf("got counter offer, accepted")
	case webrtc.SDPTypeAnswer:
		err = c.pc.SetRemoteDescription(remote)
		if err != nil {
			return nil, err
		}
		log.Printf("got answer, accepted")
	default:
		return nil, fmt.Errorf("unknown sdp type: %v", remote.Type)
	}

	select {
	case <-c.opened:
		return c, nil
	case err := <-c.err:
		return nil, err
	}
}

func main() {
	flag.Parse()
	if flag.NArg() != 1 {
		flag.PrintDefaults()
		os.Exit(-1)
	}
	slot := flag.Arg(0)

	c, err := dial(slot)
	if err != nil {
		log.Fatalf("could not dial: %v", err)
	}

	done := make(chan struct{})

	// The recieve end of the pipe.
	go func() {
		n, err := io.Copy(os.Stdout, c.rwc)
		if err != nil {
			log.Printf("could not write to stdout: %v", err)
		}
		log.Printf("debug: rx %v", n)
		done <- struct{}{}
	}()

	// The send end of the pipe.
	go func() {
		// The webrtc package's channel does not have a blocking Write, so
		// we can't just use io.Copy until the issue is fixed upsteam.
		// Work around this by buffering here and waiting for flushes.
		// https://github.com/pion/sctp/issues/77
		// n, err := io.Copy(c.rwc, os.Stdin)
		buf := make([]byte, 32<<10) // 32 KiB buffer.
		var err error
		n, count := 0, 0
		for {
			// Block to empty buffer every X MiB.
			// There's probably a less janky way.
			count++
			if (count % 160) == 0 {
				log.Println(count)
				c.flushc.L.Lock()
				for c.d.BufferedAmount() != 0 {
					c.flushc.Wait()
				}
				c.flushc.L.Unlock()
			}
			nr, er := os.Stdin.Read(buf)
			if nr > 0 {
				nw, ew := c.rwc.Write(buf[0:nr])
				n += nw
				if ew != nil {
					err = ew
					break
				}
				if nr != nw {
					err = io.ErrShortWrite
					break
				}
			}
			if er != nil {
				if er != io.EOF {
					err = er
				}
				break
			}
		}
		if err != nil {
			log.Printf("could not write to channel: %v", err)
		}
		log.Printf("debug: tx %v", n)
		done <- struct{}{}
	}()

	<-done
	c.flushc.L.Lock()
	for c.d.BufferedAmount() != 0 {
		c.flushc.Wait()
	}
	c.flushc.L.Unlock()
	c.rwc.Close()
	c.d.Close()
	c.pc.Close()
}
