package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/pion/webrtc/v2"
)

var opened = make(chan struct{})

func newPeerConn() (*webrtc.PeerConnection, *webrtc.DataChannel, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	})
	if err != nil {
		return nil, nil, err
	}

	negotiated := true
	d, err := pc.CreateDataChannel("data", &webrtc.DataChannelInit{
		Negotiated: &negotiated,
		ID:         new(uint16),
	})
	if err != nil {
		return nil, nil, err
	}

	d.OnOpen(func() {
		close(opened)
	})
	d.OnMessage(func(msg webrtc.DataChannelMessage) {
		_, err := os.Stdout.Write(msg.Data)
		if err != nil {
			log.Printf("Couldn't write message to standard out: %v", err)
		}
	})
	return pc, d, nil
}

func main() {
	var slot = os.Args[1]

	pc, d, err := newPeerConn()
	if err != nil {
		log.Fatal(err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		log.Fatal(err)
	}

	err = pc.SetLocalDescription(offer)
	if err != nil {
		log.Fatal(err)
	}

	o, err := json.Marshal(offer)
	if err != nil {
		log.Fatal(err)
	}
	res, err := http.Post("https://minimumsignal.0f.io/"+slot, "application/json", bytes.NewReader(o))
	if err != nil {
		log.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		log.Fatal("not okay")
	}

	var remote webrtc.SessionDescription
	err = json.NewDecoder(res.Body).Decode(&remote)
	if err != nil {
		log.Fatal(err)
	}

	switch remote.Type {
	case webrtc.SDPTypeOffer:
		// The webrtc package does not support rollback. Make a new PeerConnection object.
		//err := pc.SetLocalDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeRollback})

		pc, d, err = newPeerConn()
		if err != nil {
			log.Fatal(err)
		}

		err = pc.SetRemoteDescription(remote)
		if err != nil {
			log.Fatal(err)
		}
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			log.Fatal(err)
		}
		err = pc.SetLocalDescription(answer)
		if err != nil {
			log.Fatal(err)
		}

		// Send back the answer
		a, err := json.Marshal(answer)
		if err != nil {
			log.Fatal(err)
		}
		res, err := http.Post("https://minimumsignal.0f.io/"+slot, "application/json", bytes.NewReader(a))
		if err != nil {
			log.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			log.Fatal("not okay")
		}
	case webrtc.SDPTypeAnswer:
		err = pc.SetRemoteDescription(remote)
		if err != nil {
			log.Fatal(err)
		}
	default:
		log.Fatalf("unknown type: %v", remote.Type)
	}

	// TODO think about SendText buffer sizes.
	<-opened
	buf := make([]byte, 16<<10)
	for {
		n, err := os.Stdin.Read(buf)
		if err == io.EOF {
			return
		}
		if err != nil {
			log.Printf("Couldn't read from standard input: %v", err)
		}
		err = d.Send(buf[:n])
		if err != nil {
			log.Printf("Couldn't send message on datachannel: %v", err)
		}
	}
}
