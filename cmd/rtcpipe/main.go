package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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
		fmt.Printf(string(msg.Data))
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

		<-opened
		err = d.SendText("hello from loser")
	case webrtc.SDPTypeAnswer:
		err = pc.SetRemoteDescription(remote)
		if err != nil {
			log.Fatal(err)
		}

		<-opened
		err = d.SendText("hello from winner")
	default:
		log.Fatalf("unknown type: %v", remote.Type)
	}

	select {}
}
