"use strict";
class Wormhole {
	constructor(signalserver, code) {
		this.protocol = "4"; // safari has no static fields
		// It is very possible that I do not understand how to us promises "correctly".
		this.finish = new Promise((fresolve, freject) => {
			this.signal = new Promise((sresolve, sreject) => {
				this.signalresolve = sresolve;
				this.signalreject = sreject;
				this.finishresolve = fresolve;
				this.finishreject = freject;
				this.dial(signalserver, code);
			});
		});
	}

	dial(signalserver, code) {
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
				this.slot = parseInt(msg.slot);
				if (isNaN(this.slot)) {
					this.fail("invalid slot");
					return;
				}
				this.newPeerConnection(msg.iceServers);
				this.signalresolve({
					code: webwormhole.encode(this.slot, this.pass),
					pc: this.pc,
				});
				this.state = "wait_for_pake_a";
				return;
			}

			case "b": {
				msg = JSON.parse(m.data);
				this.newPeerConnection(msg.iceServers);
				this.signalresolve({
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
				this.state = "wait_for_webtc_answer";
				this.pc.createOffer().then((offer) => {
					console.log("created offer");
					this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)));
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
					this.ws.close();
					return;
				}
				if (msg.type !== "offer") {
					console.log("unexpected message", msg);
					this.fail("unexpected message");
					return;
				}
				console.log("got offer");
				this.state = "wait_for_candidates";
				this.pc.setRemoteDescription(new RTCSessionDescription(msg)).then(() => {
					this.pc.createAnswer().then((answer) => {
						console.log("created answer");
						this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)));
						this.finishresolve(webwormhole.fingerprint(this.key));
						this.pc.setLocalDescription(answer);
					});
				});
				return;
			}

			case "wait_for_webtc_answer": {
				msg = JSON.parse(webwormhole.open(this.key, m.data));
				if (msg == null) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close();
					return;
				}
				if (msg.type !== "answer") {
					console.log("unexpected message", msg);
					this.fail("unexpected message");
					return;
				}
				console.log("got answer");
				this.pc.setRemoteDescription(new RTCSessionDescription(msg));
				this.finishresolve(webwormhole.fingerprint(this.key));
				this.state = "wait_for_candidates";
				return;
			}

			case "wait_for_candidates": {
				msg = JSON.parse(webwormhole.open(this.key, m.data));
				if (msg == null) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close();
					return;
				}
				console.log("got remote candidate");
				this.pc.addIceCandidate(new RTCIceCandidate(msg));
				return;
			}

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
				console.log("got local candidate");
				this.ws.send(webwormhole.seal(this.key, JSON.stringify(e.candidate)));
			} else if (!e.candidate) {
				Wormhole.logNAT(this.pc.localDescription.sdp);
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
		// TODO hardcoded codes here for now. At somepoint, dialling code should
		// be in the wasm portion and reuse server symbols.
		if (e.code === 4_000) {
			this.fail("no such slot");
		} else if (e.code === 4_001) {
			this.fail("timed out");
		} else if (e.code === 4_002) {
			this.fail("could not get slot");
		} else if (e.code === 4_003) {
			this.fail("wrong protocol version, must update");
		} else if (e.code === 4_004 || e.code === 1_001) {
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
		this.signalreject(reason);
		this.finishreject(reason);
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

	// logNAT tries to guess the type of NAT based on candidates and log it.
	static logNAT(sdp) {
		let count = 0;
		let host = 0;
		let srflx = 0;
		const portmap = new Map();

		const lines = sdp.replace(/\r/g, "").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].startsWith("a=candidate:")) {
				continue;
			}
			const parts = lines[i].substring("a=candidate:".length).split(" ");
			const proto = parts[2].toLowerCase();
			const port = parts[5];
			const typ = parts[7];
			if (proto !== "udp") {
				continue;
			}
			count++;
			if (typ === "host") {
				host++;
			} else if (typ === "srflx") {
				srflx++;
				let rport = "";
				for (let j = 8; j < parts.length; j += 2) {
					if (parts[j] === "rport") {
						rport = parts[j + 1];
					}
				}
				if (!portmap.get(rport)) {
					portmap.set(rport, new Set());
				}
				portmap.get(rport).add(port);
			}
		}
		console.log(`local udp candidates: ${count} (host: ${host} stun: ${srflx})`);
		let maxmapping = 0;
		portmap.forEach((v) => {
			if (v.size > maxmapping) {
				maxmapping = v.size;
			}
		});
		if (maxmapping === 0) {
			console.log("nat: ice disabled or stun blocked");
		} else if (maxmapping === 1) {
			console.log("nat: 1:1 port mapping");
		} else if (maxmapping > 1) {
			console.log("nat: 1:n port mapping (bad news?)");
		} else {
			console.log("nat: failed to estimate nat type");
		}
		console.log(
			"for more webrtc troubleshooting try https://test.webrtc.org/ and your browser webrtc logs (about:webrtc or chrome://webrtc-internals/)",
		);
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
