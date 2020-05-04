// Package wormhole implements a signalling protocol to establish password protected
// WebRTC connections between peers.
//
// WebRTC uses DTLS-RSTP (https://tools.ietf.org/html/rfc5764) to secure its
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
//	----open------------------>
//	<---new_slot---------------
//	<-----------------------------------------pake_msg_a----
//	----pake_msg_b----------------------------------------->
//	----sbox(offer)---------------------------------------->
//	<---------------------------------------sbox(answer)----
//	----sbox(candidates...)-------------------------------->
//	<--------------------------------sbox(candidates...)----
package wormhole

import (
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/url"
	"path"
	"sync"
	"time"

	"filippo.io/cpace"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v2"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/nacl/secretbox"
)

// protocolVersion is an identifier for the current signalling scheme.
// It's intended to help clients print a friendlier message urging them
// to upgrade if the signalling server has a diffect version.
const protocolVersion = "3"

// ErrBadVersion is returned when the signalling server runs an incompatible
// version of the signalling protocol.
var ErrBadVersion = errors.New("bad version")

// Accessing pion/webrtc APIs like DataChannel.Detach() requires
// that we do this voodoo.
var rtcapi *webrtc.API

func init() {
	s := webrtc.SettingEngine{}
	s.DetachDataChannels()
	rtcapi = webrtc.NewAPI(webrtc.WithSettingEngine(s))
}

// Conn is a WebRTC data channel connection. It is wraps webrtc.DataChannel.
type Conn struct {
	io.ReadWriteCloser
	d  *webrtc.DataChannel
	pc *webrtc.PeerConnection

	// wsaddr is the url to the signalling websocket.
	wsaddr string

	// opened signals that the underlying DataChannel is open and ready
	// to handle data.
	opened chan struct{}
	// err forwards errors from the OnError callback.
	err chan error
	// flushc is a condition variable to coordinate flushed state of the
	// underlying channel.
	flushc *sync.Cond
}

func (c *Conn) Write(p []byte) (n int, err error) {
	// The webrtc package's channel does not have a blocking Write, so
	// we can't just use io.Copy until the issue is fixed upsteam.
	// Work around this by blocking here and waiting for flushes.
	// https://github.com/pion/sctp/issues/77
	c.flushc.L.Lock()
	for c.d.BufferedAmount() > c.d.BufferedAmountLowThreshold() {
		c.flushc.Wait()
	}
	c.flushc.L.Unlock()
	return c.ReadWriteCloser.Write(p)
}

// TODO benchmark this buffer madness.
func (c *Conn) flushed() {
	c.flushc.L.Lock()
	c.flushc.Signal()
	c.flushc.L.Unlock()
}

func (c *Conn) Close() (err error) {
	for c.d.BufferedAmount() != 0 {
		// SetBufferedAmountLowThreshold does not seem to take effect
		// when after the last Write().
		time.Sleep(time.Second) // ew.
	}
	tryclose := func(c io.Closer) {
		e := c.Close()
		if e != nil {
			err = e
		}
	}
	defer tryclose(c.pc)
	defer tryclose(c.d)
	defer tryclose(c.ReadWriteCloser)
	return nil
}

func (c *Conn) open() {
	var err error
	c.ReadWriteCloser, err = c.d.Detach()
	if err != nil {
		c.err <- err
		return
	}
	close(c.opened)
}

// It's not really clear to me when this will be invoked.
func (c *Conn) error(err error) {
	log.Printf("debug: %v", err)
	c.err <- err
}

func readEncJSON(ws *websocket.Conn, key *[32]byte, v interface{}) error {
	_, buf, err := ws.ReadMessage()
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
		return errors.New("bad key")
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
	return ws.WriteMessage(
		websocket.TextMessage,
		[]byte(base64.URLEncoding.EncodeToString(
			secretbox.Seal(nonce[:], jsonmsg, &nonce, key),
		)),
	)
}

func readBase64(ws *websocket.Conn) ([]byte, error) {
	_, buf, err := ws.ReadMessage()
	if err != nil {
		return nil, err
	}
	return base64.URLEncoding.DecodeString(string(buf))
}

func writeBase64(ws *websocket.Conn, p []byte) error {
	return ws.WriteMessage(websocket.TextMessage, []byte(base64.URLEncoding.EncodeToString(p)))
}

func readString(ws *websocket.Conn) (string, error) {
	_, buf, err := ws.ReadMessage()
	return string(buf), err
}

// addCandidates waits for candidate to trickle in. We close the websocket
// when we get a successful connection so this should fail and exit at some
// point.
func (c *Conn) addCandidates(ws *websocket.Conn, key *[32]byte) {
	for {
		var candidate webrtc.ICECandidateInit
		err := readEncJSON(ws, key, &candidate)
		if err != nil {
			return
		}
		err = c.pc.AddICECandidate(candidate)
		if err != nil {
			return
		}
	}
}

func newConn(sigserv string, iceserv []string) (*Conn, error) {
	c := &Conn{
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
	u.Path = path.Join(u.Path, "/s/")
	c.wsaddr = u.String()

	rtccfg := webrtc.Configuration{}
	for i := range iceserv {
		if iceserv[i] != "" {
			rtccfg.ICEServers = append(rtccfg.ICEServers, webrtc.ICEServer{URLs: []string{iceserv[i]}})
		}
	}
	c.pc, err = rtcapi.NewPeerConnection(rtccfg)
	if err != nil {
		return nil, err
	}
	sigh := true
	c.d, err = c.pc.CreateDataChannel("data", &webrtc.DataChannelInit{
		Negotiated: &sigh,
		ID:         new(uint16),
	})
	if err != nil {
		return nil, err
	}
	c.d.OnOpen(c.open)
	c.d.OnError(c.error)
	c.d.OnBufferedAmountLow(c.flushed)
	// Any threshold amount >= 1MiB seems to occasionally lock up pion.
	// Choose 512 KiB as a safe default.
	c.d.SetBufferedAmountLowThreshold(512 << 10)

	return c, nil
}

// Wormhole is like Dial, but asks the signalling server to assign it a slot
// and writes it to slotc as soon as it gets it.
func Wormhole(pass string, sigserv string, iceserv []string, slotc chan string) (*Conn, error) {
	c, err := newConn(sigserv, iceserv)
	if err != nil {
		return nil, err
	}
	ws, r, err := websocket.DefaultDialer.Dial(c.wsaddr+"/", nil)
	if err != nil {
		if r != nil && r.Header.Get("X-Version") != protocolVersion {
			return nil, ErrBadVersion
		}
		return nil, err
	}

	slot, err := readString(ws)
	if err != nil {
		return nil, err
	}
	slotc <- slot

	msgA, err := readBase64(ws)
	if err != nil {
		return nil, err
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

	offer, err := c.pc.CreateOffer(nil)
	if err != nil {
		return nil, err
	}
	err = c.pc.SetLocalDescription(offer)
	if err != nil {
		return nil, err
	}
	err = writeEncJSON(ws, &key, offer)
	if err != nil {
		return nil, err
	}

	var answer webrtc.SessionDescription
	err = readEncJSON(ws, &key, &answer)
	if err != nil {
		return nil, err
	}
	err = c.pc.SetRemoteDescription(answer)
	if err != nil {
		return nil, err
	}

	go c.addCandidates(ws, &key)

	// TODO put a timeout here.
	select {
	case <-c.opened:
	case err = <-c.err:
	}

	ws.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"),
		time.Now().Add(10*time.Second),
	)
	return c, err
}

// Dial returns an established WebRTC data channel to a peer.
//
// slot is used to synchronise with the remote peer on signalling server
// sigserv, and pass is used as the PAKE password authenticate the WebRTC
// offer and answer.
//
// iceserv is an optional list of STUN and TURN URLs to use for NAT traversal.
func Dial(slot, pass string, sigserv string, iceserv []string) (*Conn, error) {
	c, err := newConn(sigserv, iceserv)
	if err != nil {
		return nil, err
	}

	// Start the handshake
	ws, r, err := websocket.DefaultDialer.Dial(c.wsaddr+"/"+slot, nil)
	if err != nil {
		if r != nil && r.Header.Get("X-Version") != protocolVersion {
			return nil, ErrBadVersion
		}
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
	err = writeBase64(ws, msgA)
	if err != nil {
		return nil, err
	}

	msgB, err := readBase64(ws)
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

	var offer webrtc.SessionDescription
	err = readEncJSON(ws, &key, &offer)
	if err != nil {
		return nil, err
	}
	err = c.pc.SetRemoteDescription(offer)
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

	err = writeEncJSON(ws, &key, answer)
	if err != nil {
		return nil, err
	}

	go c.addCandidates(ws, &key)

	// TODO put a timeout here.
	select {
	case <-c.opened:
	case err = <-c.err:
	}

	ws.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"),
		time.Now().Add(10*time.Second),
	)
	return c, err
}
