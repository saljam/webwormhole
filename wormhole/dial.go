// Package wormhole implements a signalling protocol to establish password protected
// WebRTC connections between peers.
//
// WebRTC uses DTLS-SRTP (https://tools.ietf.org/html/rfc5764) to secure its
// data. The mechanism it uses to exchange keys relies on exchanging metadata
// that includes both endpoints' certificate fingerprints via some trusted channel,
// typically a signalling server over https and websockets. More in RFC5763
// (https://tools.ietf.org/html/rfc5763).
//
// This package removes the signalling server from the trust model by using a
// PAKE to estabish the authenticity of the WebRTC metadata. In other words,
// it's a clone of Magic Wormhole made to use WebRTC as the transport.
//
// The protocol requires a signalling server that facilitates exchanging
// arbitrary messages via a slot system. The server subcommand of the
// ww tool is an implementation of this over WebSockets.
//
// Rough sketch of the handshake:
//
//	Peer               Signalling Server                Peer
//	----open------------------> |
//	<---new_slot,TURN_ticket--- |
//	                            | <------------------open----
//	                            | ------------TURN_ticket--->
//	<---------------------------|--------------pake_msg_a----
//	----pake_msg_b--------------|--------------------------->
//	----sbox(offer)-------------|--------------------------->
//	<---------------------------|------------sbox(answer)----
//	----sbox(candidates...)-----|--------------------------->
//	<---------------------------|-----sbox(candidates...)----
package wormhole

import (
	"context"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"filippo.io/cpace"
	webrtc "github.com/pion/webrtc/v2"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/nacl/secretbox"
	"nhooyr.io/websocket"
)

// Protocol is an identifier for the current signalling scheme. It's
// intended to help clients print a friendlier message urging them to
// upgrade if the signalling server has a different version.
const Protocol = "4"

const (
	// CloseNoSuchSlot is the WebSocket status returned if the slot is not valid.
	CloseNoSuchSlot = 4000 + iota
	// CloseSlotTimedOut is the WebSocket status returned when the slot times out.
	CloseSlotTimedOut
	// CloseNoMoreSlots is the WebSocket status returned when the signalling server
	// cannot allocate any new slots at the time.
	CloseNoMoreSlots
	// CloseWrongProto is the WebSocket status returned when the signalling server
	// runs a different version of the signalling protocol.
	CloseWrongProto
	// ClosePeerHungUp is the WebSocket status returned when the peer has closed
	// its connection.
	ClosePeerHungUp
	// CloseBadKey is the WebSocket status returned when the peer has closed its
	// connection because the key it derived is bad.
	CloseBadKey
)

// Verbose logging.
var Verbose = false

// ErrBadVersion is returned when the signalling server runs an incompatible
// version of the signalling protocol.
var ErrBadVersion = errors.New("bad version")

// ErrBadVersion is returned when the the peer on the same slot uses a different
// password.
var ErrBadKey = errors.New("bad key")

// Accessing pion/webrtc APIs like DataChannel.Detach() requires
// that we do this voodoo.
var rtcapi *webrtc.API

func init() {
	s := webrtc.SettingEngine{}
	s.DetachDataChannels()
	s.SetTrickle(true)
	rtcapi = webrtc.NewAPI(webrtc.WithSettingEngine(s))
}

// A Wormhole is a WebRTC connection established via the WebWormhole signalling
// protocol. It is wraps webrtc.PeerConnection and webrtc.DataChannel.
//
// BUG(s): A PeerConnection established via Wormhole will always have a DataChannel
// created for it, with the name "data" and id 0.
type Wormhole struct {
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

// Read writes a message to the default DataChannel.
func (c *Wormhole) Write(p []byte) (n int, err error) {
	// The webrtc package's channel does not have a blocking Write, so
	// we can't just use io.Copy until the issue is fixed upsteam.
	// Work around this by blocking here and waiting for flushes.
	// https://github.com/pion/sctp/issues/77
	c.flushc.L.Lock()
	for c.d.BufferedAmount() > c.d.BufferedAmountLowThreshold() {
		c.flushc.Wait()
	}
	c.flushc.L.Unlock()
	return c.rwc.Write(p)
}

// Read read a message from the default DataChannel.
func (c *Wormhole) Read(p []byte) (n int, err error) {
	return c.rwc.Read(p)
}

// TODO benchmark this buffer madness.
func (c *Wormhole) flushed() {
	c.flushc.L.Lock()
	c.flushc.Signal()
	c.flushc.L.Unlock()
}

// Close attempts to flush the DataChannel buffers then close it
// and its PeerConnection.
func (c *Wormhole) Close() (err error) {
	if Verbose {
		log.Printf("closing")
	}
	for c.d.BufferedAmount() != 0 {
		// SetBufferedAmountLowThreshold does not seem to take effect
		// when after the last Write().
		time.Sleep(time.Second) // eww.
	}
	tryclose := func(c io.Closer) {
		e := c.Close()
		if e != nil {
			err = e
		}
	}
	defer tryclose(c.pc)
	defer tryclose(c.d)
	defer tryclose(c.rwc)
	return nil
}

func (c *Wormhole) open() {
	var err error
	c.rwc, err = c.d.Detach()
	if err != nil {
		c.err <- err
		return
	}
	close(c.opened)
}

// It's not really clear to me when this will be invoked.
func (c *Wormhole) error(err error) {
	log.Printf("debug: %v", err)
	c.err <- err
}

func readEncJSON(ws *websocket.Conn, key *[32]byte, v interface{}) error {
	_, buf, err := ws.Read(context.TODO())
	if err != nil {
		return err
	}
	encrypted, err := base64.URLEncoding.DecodeString(string(buf))
	if err != nil {
		return err
	}
	var nonce [24]byte
	copy(nonce[:], encrypted[:24])
	jsonmsg, ok := secretbox.Open(nil, encrypted[24:], &nonce, key)
	if !ok {
		return ErrBadKey
	}
	return json.Unmarshal(jsonmsg, v)
}

func writeEncJSON(ws *websocket.Conn, key *[32]byte, v interface{}) error {
	jsonmsg, err := json.Marshal(v)
	if err != nil {
		return err
	}
	var nonce [24]byte
	if _, err := io.ReadFull(crand.Reader, nonce[:]); err != nil {
		return err
	}
	return ws.Write(
		context.TODO(),
		websocket.MessageText,
		[]byte(base64.URLEncoding.EncodeToString(
			secretbox.Seal(nonce[:], jsonmsg, &nonce, key),
		)),
	)
}

func readBase64(ws *websocket.Conn) ([]byte, error) {
	_, buf, err := ws.Read(context.TODO())
	if err != nil {
		return nil, err
	}
	return base64.URLEncoding.DecodeString(string(buf))
}

func writeBase64(ws *websocket.Conn, p []byte) error {
	return ws.Write(
		context.TODO(),
		websocket.MessageText,
		[]byte(base64.URLEncoding.EncodeToString(p)),
	)
}

// initmsg is the first message the signalling server sends over
// the WebSocket connection.
type initmsg struct {
	Slot       string             `json:"slot",omitempty`
	ICEServers []webrtc.ICEServer `json:"iceServers",omitempty`
}

func readInitMsg(ws *websocket.Conn) (m initmsg, err error) {
	_, buf, err := ws.Read(context.TODO())
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(buf, &m)
	return m, err
}

// addCandidates waits for candidate to trickle in. We close the websocket
// when we get a successful connection so this should fail and exit at some
// point.
func (c *Wormhole) addCandidates(ws *websocket.Conn, key *[32]byte) {
	for {
		var candidate webrtc.ICECandidateInit
		err := readEncJSON(ws, key, &candidate)
		if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
			return
		}
		if err != nil {
			if Verbose {
				log.Printf("cannot read remote candidate: %v", err)
			}
			return
		}
		if Verbose {
			log.Printf("received new remote candidate")
		}
		err = c.pc.AddICECandidate(candidate)
		if err != nil {
			if Verbose {
				log.Printf("cannot add candidate: %v", err)
			}
			return
		}
	}
}

// logNAT tries to guess the type of NAT based on candidates and log it.
func logNAT(sdp string) {
	count, host, srflx := 0, 0, 0
	portmap := map[string]map[string]bool{}
	lines := strings.Split(strings.ReplaceAll(sdp, "\r", ""), "\n")
	for _, l := range lines {
		if !strings.HasPrefix(l, "a=candidate:") {
			continue
		}
		parts := strings.Split(l[len("a=candidate:"):], " ")
		proto := strings.ToLower(parts[2])
		port := parts[5]
		typ := parts[7]
		if proto != "udp" {
			continue
		}
		count++
		if typ == "host" {
			host++
		} else if typ == "srflx" {
			srflx++
			var rport string
			for i := 8; i < len(parts); i += 2 {
				if parts[i] == "rport" {
					rport = parts[i+1]
					break
				}
			}
			if portmap[rport] == nil {
				portmap[rport] = map[string]bool{}
			}
			portmap[rport][port] = true
		}
	}
	log.Printf("local udp candidates: %d (host: %d stun: %d)", count, host, srflx)
	maxmapping := 0
	for _, v := range portmap {
		if len(v) > maxmapping {
			maxmapping = len(v)
		}
	}
	switch maxmapping {
	case 0:
		log.Printf("nat: unknown: ice disabled or stun blocked")
	case 1:
		if srflx == 1 {
			log.Printf("nat: not enough stun servers to tell")
		} else {
			log.Printf("nat: 1:1 port mapping")
		}
	default:
		log.Printf("nat: symmetric: 1:n port mapping (bad news)")
	}
}

func (c *Wormhole) newPeerConnection(ice []webrtc.ICEServer) error {
	var err error
	c.pc, err = rtcapi.NewPeerConnection(webrtc.Configuration{
		ICEServers: ice,
	})
	if err != nil {
		return err
	}

	sigh := true
	c.d, err = c.pc.CreateDataChannel("data", &webrtc.DataChannelInit{
		Negotiated: &sigh,
		ID:         new(uint16),
	})
	if err != nil {
		return err
	}
	c.d.OnOpen(c.open)
	c.d.OnError(c.error)
	c.d.OnBufferedAmountLow(c.flushed)
	// Any threshold amount >= 1MiB seems to occasionally lock up pion.
	// Choose 512 KiB as a safe default.
	c.d.SetBufferedAmountLowThreshold(512 << 10)
	return nil
}

func (c *Wormhole) IsRelay() bool {
	stats := c.pc.GetStats()
	for _, s := range stats {
		pairstats, ok := s.(webrtc.ICECandidatePairStats)
		if !ok {
			continue
		}
		if !pairstats.Nominated {
			continue
		}
		local, ok := stats[pairstats.LocalCandidateID].(webrtc.ICECandidateStats)
		if !ok {
			continue
		}
		remote, ok := stats[pairstats.RemoteCandidateID].(webrtc.ICECandidateStats)
		if !ok {
			continue
		}
		if remote.CandidateType == webrtc.ICECandidateTypeRelay ||
			local.CandidateType == webrtc.ICECandidateTypeRelay {
			return true
		}
	}
	return false
}

// New starts a new signalling handshake after asking the server to allocate
// a new slot.
//
// The slot is used to synchronise with the remote peer on signalling server
// sigserv, and pass is used as the PAKE password authenticate the WebRTC
// offer and answer.
//
// The server generated slot identifier is written on slotc.
//
// If pc is nil it initialises ones using the default STUN server.
func New(pass string, sigserv string, slotc chan string) (*Wormhole, error) {
	c := &Wormhole{
		opened: make(chan struct{}),
		err:    make(chan error),
		flushc: sync.NewCond(&sync.Mutex{}),
	}

	u, err := url.Parse(sigserv)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "http" || u.Scheme == "ws" {
		u.Scheme = "ws"
	} else {
		u.Scheme = "wss"
	}
	wsaddr := u.String()

	ws, _, err := websocket.Dial(context.TODO(), wsaddr, &websocket.DialOptions{
		Subprotocols: []string{Protocol},
	})
	if err != nil {
		return nil, err
	}

	m, err := readInitMsg(ws)
	if websocket.CloseStatus(err) == CloseWrongProto {
		return nil, ErrBadVersion
	}
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("connected to signalling server, got slot: %v", m.Slot)
	}
	slotc <- m.Slot
	err = c.newPeerConnection(m.ICEServers)
	if err != nil {
		return nil, err
	}

	msgA, err := readBase64(ws)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("got A pake msg (%v bytes)", len(msgA))
	}

	msgB, mk, err := cpace.Exchange(pass, cpace.NewContextInfo("", "", nil), msgA)
	if err != nil {
		return nil, err
	}
	key := [32]byte{}
	_, err = io.ReadFull(hkdf.New(sha256.New, mk, nil, nil), key[:])
	if err != nil {
		return nil, err
	}
	err = writeBase64(ws, msgB)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("have key, sent B pake msg (%v bytes)", len(msgB))
	}

	c.pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			if Verbose {
				logNAT(c.pc.LocalDescription().SDP)
			}
			return
		}
		err := writeEncJSON(ws, &key, candidate.ToJSON())
		if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
			return
		}
		if err != nil {
			if Verbose {
				log.Printf("cannot send local candidate: %v", err)
			}
			return
		}
		if Verbose {
			log.Printf("sent new local candidate")
		}
	})

	offer, err := c.pc.CreateOffer(nil)
	if err != nil {
		return nil, err
	}
	err = writeEncJSON(ws, &key, offer)
	if err != nil {
		return nil, err
	}
	err = c.pc.SetLocalDescription(offer)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("sent offer")
	}

	var answer webrtc.SessionDescription
	err = readEncJSON(ws, &key, &answer)
	if websocket.CloseStatus(err) == CloseBadKey {
		return nil, ErrBadKey
	}
	if err != nil {
		return nil, err
	}
	err = c.pc.SetRemoteDescription(answer)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("got answer")
	}

	go c.addCandidates(ws, &key)

	// TODO put a timeout here.
	select {
	case <-c.opened:
		if Verbose {
			log.Printf("webrtc connection succeeded, closing signalling channel")
		}
	case err = <-c.err:
	}
	ws.Close(websocket.StatusNormalClosure, "done")
	return c, err
}

// Join performs the signalling handshake to join an existing slot.
//
// slot is used to synchronise with the remote peer on signalling server
// sigserv, and pass is used as the PAKE password authenticate the WebRTC
// offer and answer.
//
// If pc is nil it initialises ones using the default STUN server.
func Join(slot, pass string, sigserv string) (*Wormhole, error) {
	c := &Wormhole{
		opened: make(chan struct{}),
		err:    make(chan error),
		flushc: sync.NewCond(&sync.Mutex{}),
	}

	u, err := url.Parse(sigserv)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "http" || u.Scheme == "ws" {
		u.Scheme = "ws"
	} else {
		u.Scheme = "wss"
	}
	u.Path += slot
	wsaddr := u.String()

	// Start the handshake.
	ws, _, err := websocket.Dial(context.TODO(), wsaddr, &websocket.DialOptions{
		Subprotocols: []string{Protocol},
	})
	if err != nil {
		return nil, err
	}

	m, err := readInitMsg(ws)
	if websocket.CloseStatus(err) == CloseWrongProto {
		return nil, ErrBadVersion
	}
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("connected to signalling server on slot: %v", slot)
	}
	err = c.newPeerConnection(m.ICEServers)
	if err != nil {
		return nil, err
	}

	// The identity arguments are to bind endpoint identities in PAKE. Cf. Unknown
	// Key-Share Attack. https://tools.ietf.org/html/draft-ietf-mmusic-sdp-uks-03
	//
	// In the context of a program like magic-wormhole we do not have ahead of time
	// information on the identity of the remote party. We only have the slot name,
	// and sometimes even that at this stage. But that's okay, since:
	//   a) The password is randomly generated and ephemeral.
	//   b) A peer only gets one guess.
	// An unintended destination is likely going to fail PAKE.

	msgA, pake, err := cpace.Start(pass, cpace.NewContextInfo("", "", nil))
	if err != nil {
		return nil, err
	}
	err = writeBase64(ws, msgA)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("sent A pake msg (%v bytes)", len(msgA))
	}

	msgB, err := readBase64(ws)
	if websocket.CloseStatus(err) == CloseWrongProto {
		return nil, ErrBadVersion
	}
	if err != nil {
		return nil, err
	}
	mk, err := pake.Finish(msgB)
	if err != nil {
		return nil, err
	}
	key := [32]byte{}
	_, err = io.ReadFull(hkdf.New(sha256.New, mk, nil, nil), key[:])
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("have key, got B msg (%v bytes)", len(msgB))
	}

	var offer webrtc.SessionDescription
	err = readEncJSON(ws, &key, &offer)
	if err == ErrBadKey {
		// Close with the right status so the other side knows to quit immediately.
		ws.Close(CloseBadKey, "bad key")
		return nil, err
	}
	if err != nil {
		return nil, err
	}

	c.pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			if Verbose {
				logNAT(c.pc.LocalDescription().SDP)
			}
			return
		}
		err := writeEncJSON(ws, &key, candidate.ToJSON())
		if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
			return
		}
		if err != nil {
			if Verbose {
				log.Printf("cannot send local candidate: %v", err)
			}
			return
		}
		if Verbose {
			log.Printf("sent new local candidate")
		}
	})

	err = c.pc.SetRemoteDescription(offer)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("got offer")
	}
	answer, err := c.pc.CreateAnswer(nil)
	if err != nil {
		return nil, err
	}
	err = writeEncJSON(ws, &key, answer)
	if err != nil {
		return nil, err
	}
	err = c.pc.SetLocalDescription(answer)
	if err != nil {
		return nil, err
	}
	if Verbose {
		log.Printf("sent answer")
	}

	go c.addCandidates(ws, &key)

	// TODO put a timeout here.
	select {
	case <-c.opened:
		if Verbose {
			log.Printf("webrtc connection succeeded, closing signalling channel")
		}
	case err = <-c.err:
	}

	ws.Close(websocket.StatusNormalClosure, "done")
	return c, err
}
