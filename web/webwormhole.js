"use strict";

class Wormhole {
	constructor(signalserver, code) {
		// Fields, let alone static fields, are not supported on older
		// browsers (e.g. firefox 68 and safari 12).

		// Signalling protocol version.
		this.protocol = "4";

		// Error codes from webwormhole/dial.go.
		this.closeNoSuchSlot = 4000;
		this.closeSlotTimedOut = 4001;
		this.closeNoMoreSlots = 4002;
		this.closeWrongProto = 4003;
		this.closePeerHungUp = 4004;
		this.closeBadKey = 4005;
		this.closeWebRTCSuccess = 4006;
		this.closeWebRTCSuccessDirect = 4007;
		this.closeWebRTCSuccessRelay = 4008;
		this.closeWebRTCFailed = 4009;

		if (code !== "") {
			[this.slot, this.pass] = webwormhole.decode(code);
			if (this.pass.length === 0) {
				throw "bad code";
			}
			console.log("dialling slot:", this.slot);
			this.state = "b";
		} else {
			this.slot = "";
			this.pass = crypto.getRandomValues(new Uint8Array(2));
			console.log("requesting slot");
			this.state = "a";
		}

		// There are 4 events that we need to synchronise with the caller on:
		//   1. we got the first message from the signalling server.
		//        We now have the slot number and the ICE server details, so we can
		//        create the wormhole code and PeerConnection object, and pass them back
		//        to the caller to display and configure, respectively.
		//   2. the caller is done configuring the PeerConnection.
		//        We can now create the offer or answer and send it to the peer.
		//   3. we've successfully authenticated the other peer.
		//        Signalling is now done, apart from any trickling candidates. The caller
		//        can display the key fingerprint.
		//   4. caller tells us the webrtc handshake is done. We can close the websocket.
		this.promise1 = new Promise((resolve1, reject1) => {
			this.promise2 = new Promise((resolve2, reject2) => {
				this.promise3 = new Promise((resolve3, reject3) => {
					this.resolve1 = resolve1;
					this.reject1 = reject1;
					this.resolve2 = resolve2;
					this.reject2 = reject2;
					this.resolve3 = resolve3;
					this.reject3 = reject3;
					this.dial(signalserver, code);
				});
			});
		});
	}

	async signal() {
		return this.promise1;
	}

	async finish() {
		this.resolve2();
		return this.promise3;
	}

	async close() {
		switch (this.pc.iceConnectionState) {
			case "connected": {
				const connType = await this.connType()
				// TODO UI to warn if relay is used.
				console.log("webrtc connected:", connType)
				switch (connType) {
					case "host":
					case "srflx":
					case "prflx": {
						this.ws.close(this.closeWebRTCSuccessDirect);
						break;
					}
					case "relay": {
						this.ws.close(this.closeWebRTCSuccessRelay);
						break;
					}
					default: {
						this.ws.close(this.closeWebRTCSuccess);
						break;
					}
				}
				break;
			}
			case "failed": {
				this.ws.close(this.closeWebRTCFailed);
				break;
			}
		}
	}

	async connType() {
		let stats = await this.pc.getStats();
		// s.selected gives more confidenece than s.state == "succeeded", but Chrome does
		// not implement it.
		let selected = [...stats.values()].find(s => s.type == "candidate-pair" && s.state == "succeeded");
		return stats.get(selected.localCandidateId).candidateType
	}

	dial(signalserver, code) {
		this.ws = new WebSocket(
			Wormhole.wsserver(signalserver, this.slot),
			this.protocol,
		);
		this.ws.onopen = (a) => {
			this.onopen(a);
		};
		this.ws.onerror = (a) => {
			this.onerror(a);
		};
		this.ws.onclose = (a) => {
			this.onclose(a);
		};
		this.ws.onmessage = (a) => {
			this.onmessage(a);
		};
	}

	onmessage(m) {
		let msg; // for decoded json

		// This all being so asynchronous makes it so the only way apparent to
		// me to describe the PAKE and WebRTC message exchange state machine
		// a big case statement. I'd welcome a clearer or more idiomatic approach
		// in JS if someone were to suggest one.
		switch (this.state) {
			case "a": {
				msg = JSON.parse(m.data);
				console.log("assigned slot:", msg.slot);
				this.slot = parseInt(msg.slot, 10);
				if (!Number.isSafeInteger(this.slot)) {
					this.fail("invalid slot");
					return;
				}
				this.newPeerConnection(msg.iceServers);
				this.resolve1({
					code: webwormhole.encode(this.slot, this.pass),
					pc: this.pc,
				});
				this.state = "wait_for_pake_a";
				return;
			}

			case "b": {
				msg = JSON.parse(m.data);
				this.newPeerConnection(msg.iceServers);
				this.resolve1({
					pc: this.pc,
				});
				const msgA = webwormhole.start(this.pass);
				if (msgA == null) {
					this.fail("couldn't generate A's PAKE message");
					return;
				}
				console.log("message a:", msgA);
				this.ws.send(msgA);
				this.state = "wait_for_pake_b";
				return;
			}

			case "wait_for_pake_a": {
				console.log("got pake message a:", m.data);
				let msgB;
				[this.key, msgB] = webwormhole.exchange(this.pass, m.data);
				console.log("message b:", msgB);
				if (this.key == null) {
					this.fail("could not generate key");
					return;
				}
				console.log("generated key");
				this.ws.send(msgB);
				this.state = "wait_for_pc_initialize";
				this.promise2.then(async () => {
					const offer = await this.pc.createOffer();
					console.log("created offer");
					this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)));
					this.state = "wait_for_webtc_answer";
					this.pc.setLocalDescription(offer);
				});
				return;
			}

			case "wait_for_pake_b": {
				console.log("got pake message b:", m.data);
				this.key = webwormhole.finish(m.data);
				if (this.key == null) {
					this.fail("could not generate key");
					return;
				}
				console.log("generated key");
				this.state = "wait_for_webtc_offer";
				return;
			}

			case "wait_for_webtc_offer": {
				msg = JSON.parse(webwormhole.open(this.key, m.data));
				if (msg == null) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close(closeBadKey);
					return;
				}
				if (msg.type !== "offer") {
					console.log("unexpected message", msg);
					this.fail("unexpected message");
					return;
				}
				console.log("got offer");
				// No intermediate state wait_for_pc_initialize because candidates can
				// staring arriving straight after the offer is sent.
				this.state = "wait_for_candidates";
				this.promise2.then(async () => {
					await this.pc.setRemoteDescription(new RTCSessionDescription(msg));
					const answer = await this.pc.createAnswer();
					console.log("created answer");
					this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)));
					this.resolve3(webwormhole.fingerprint(this.key));
					this.pc.setLocalDescription(answer);
				});
				return;
			}

			case "wait_for_webtc_answer": {
				msg = JSON.parse(webwormhole.open(this.key, m.data));
				if (msg == null) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close(closeBadKey);
					return;
				}
				if (msg.type !== "answer") {
					console.log("unexpected message", msg);
					this.fail("unexpected message");
					return;
				}
				console.log("got answer");
				this.pc.setRemoteDescription(new RTCSessionDescription(msg));
				this.resolve3(webwormhole.fingerprint(this.key));
				this.state = "wait_for_candidates";
				return;
			}

			case "wait_for_candidates": {
				msg = JSON.parse(webwormhole.open(this.key, m.data));
				if (msg == null) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close(closeBadKey);
					return;
				}
				console.log("got remote candidate", msg.candidate);
				this.promise2.then(async () => {
					this.pc.addIceCandidate(new RTCIceCandidate(msg));
				});
				return;
			}

			case "wait_for_pc_initialize":
			case "wait_for_local_offer":
			case "wait_for_local_answer": {
				console.log("unexpected message", m);
				this.fail("unexpected message");
				return;
			}
			case "error":
				return;
		}
	}

	newPeerConnection(iceServers) {
		let normalisedICEServers = [];
		for (let i = 0; i < iceServers.length; i++) {
			normalisedICEServers.push({
				urls: iceServers[i].URLs,
				username: iceServers[i].Username,
				credential: iceServers[i].Credential,
			});
		}
		this.pc = new RTCPeerConnection({
			iceServers: normalisedICEServers,
		});
		this.pc.onicecandidate = (e) => {
			if (e.candidate && e.candidate.candidate !== "") {
				console.log("got local candidate", e.candidate.candidate);
				this.ws.send(webwormhole.seal(this.key, JSON.stringify(e.candidate)));
			}
		};
	}

	onopen() {
		console.log("websocket session established");
	}

	onerror(e) {
		console.log("websocket session error:", e);
		this.fail("could not connect to signalling server");
	}

	onclose(e) {
		if (e.code === 4000) {
			this.fail("no such slot");
		} else if (e.code === 4001) {
			this.fail("timed out");
		} else if (e.code === 4002) {
			this.fail("could not get slot");
		} else if (e.code === 4003) {
			this.fail("wrong protocol version, must update");
		} else if (e.code === 4004 || e.code === 1001) {
			// Workaround for regression introduced in firefox around version ~78.
			// Usually the websocket connection stays open for the duration of the session, since
			// it doesn't hurt and it make candidate trickling easier. We only do this here out of
			// laziness. The go code has more disciplined websocket lifecycle management.
			// Recent versions of Firefox introduced a bug where websocket connections are killed
			// when a download begins. This would happen after the WebRTC connection is set up
			// so it's not really an error we need to react to.
		} else {
			this.fail(`websocket session closed: ${e.reason} (${e.code})`);
		}
	}

	fail(reason) {
		this.reject1(reason);
		this.reject3(reason);
		this.state = "error";
	}

	// wsserver creates a WebSocket scheme (ws: or wss:) URL from an HTTP one.
	static wsserver(url, slot) {
		const u = new URL(url);
		let protocol = "wss:";
		if (u.protocol === "http:") {
			protocol = "ws:";
		}
		let path = u.pathname + slot;
		if (!path.startsWith("/")) {
			path = `/${path}`;
		}
		return `${protocol}//${u.host}${path}`;
	}

	// WASM loads the WebAssembly part from url.
	static async WASM(url) {
		// Polyfill for Safari WASM streaming.
		if (!WebAssembly.instantiateStreaming) {
			WebAssembly.instantiateStreaming = async (resp, importObject) => {
				const source = await (await resp).arrayBuffer();
				return await WebAssembly.instantiate(source, importObject);
			};
		}
		const go = new Go();
		const wasm = await WebAssembly.instantiateStreaming(
			fetch(url),
			go.importObject,
		);
		go.run(wasm.instance);
	}
}
