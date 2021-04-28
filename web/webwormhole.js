"use strict";

const matchMessage = (type, rawMessage) => {
  if (!type) return true
  let parsed
  try {
	parsed = JSON.parse(rawMessage)
  } catch (e) {}
  return parsed?.data?.type === type
}

const wait = async (ws, type, timeout) => {
  return new Promise((resolve) => {
	let timeoutID
	if (timeout) {
	  timeoutID = setTimeout(() => {
		cleanup()
		resolve([undefined, new Error('TimeoutError')])
	  }, timeout)
	}

	const listener = (rawMessage) => {
	  if (matchMessage(type, rawMessage)) {
		clearTimeout(timeoutID)
		cleanup()
		resolve([rawMessage])
	  }
	}

	const errorListener = (error) => {
	  cleanup()
	  resolve([undefined, error])
	}

	const cleanup = () => {
	  ws.removeEventListener('message', listener)
	  ws.removeEventListener('error', errorListener)
	}

	ws.addEventListener('message', listener)
	ws.addEventListener('error', errorListener)
  })
}

const createDeferredPromise = () => {
  let ret = { isPending: true, isFulfilled: false, isRejected: false }
  ret.promise = new Promise((res, rej) => {
	ret.resolve = (...args) => {
	  ret.isPending = false
	  ret.isFulfilled = true
	  res(...args)
	}
	ret.reject = (...args) => {
	  ret.isPending = false
	  ret.isRejected = true
	  rej(...args)
	}
  })
  return ret
}


class Wormhole {
	constructor(signalserver, code) {
		this.protocol = "4"; // safari has no static fields
		// There are 3 events that we need to synchronise with the caller on:
		//   1. we got the first message from the signalling server.
		//        We now have the slot number and the ICE server details, so we can
		//        create the wormhole code and PeerConnection object, and pass them back
		//        to the caller to display and configure, respectively.
		//   2. the caller is done configuring the PeerConnection.
		//        We can now create the offer or answer and send it to the peer.
		//   3. we've successfully authenticated the other peer.
		//        Signalling is now done, apart from any trickling candidates. The called
		//        can display the key fingerprint.
		//   4. (unimplemented) caller tells us the webrtc handshake is done.
		//        We can close the websocket.
		this.phase1 = createDeferredPromise();
		this.phase2 = createDeferredPromise();
		this.phase3 = createDeferredPromise();
		this.dial(signalserver, code);
	}

	async signal() {
		return this.phase1.promise;
	}

	async finish() {
		this.phase2.resolve();
		return this.phase3.promise;
	}

	dial(signalserver, code) {
		const hasCode = Boolean(code)
		
		if (hasCode) {
			[this.slot, this.pass] = webwormhole.decode(code);
			if (this.pass.length === 0) throw "bad code"
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

		if (hasCode) return this.join()
		return this.new()
	}

	async new() {
		await this.waitForSlotA()
		await this.waitForPakeA()
		await this.waitForPcInitialize()
		await this.createOffer()
		await this.waitForWebRtcAnswer()
		await this.waitForCandidates()
	}

	async join() {
		await this.waitForSlotB()
		await this.waitForPakeB()
		await this.waitForWebRtcOffer()
		await this.waitForPcInitialize()
		await this.createAnswer()
		await this.waitForCandidates()
	}
	

	async waitForSlotA() {
		const [rawMessage, error] = await wait(this.ws)
		if (error) return
		const msg = JSON.parse(rawMessage.data)
		console.log('assigned slot:', msg.slot)
		this.slot = parseInt(msg.slot, 10)
		if (!Number.isSafeInteger(this.slot)) return this.fail('invalid slot')

		this.newPeerConnection(msg.iceServers)
		
		const code = webwormhole.encode(this.slot, this.pass)
		this.phase1.resolve({ code, pc: this.pc })
		this.state = 'wait_for_pake_a'
	}
	
	
	async waitForPakeA() {
		const [m, error] = await wait(this.ws)
		if (error) return
		console.log('got pake message a:', m.data)
		const [key, msgB] = webwormhole.exchange(this.pass, m.data)
		this.key = key
		console.log('message b:', msgB)
		if (this.key === null) return this.fail('could not generate key')
		console.log('generated key')
		this.ws.send(msgB)
		this.state = 'wait_for_pc_initialize'
	}

	async waitForPcInitialize() {
		await this.phase2.promise
	}

	async createOffer() {
		const offer = await this.pc.createOffer()
		console.log('created offer')
		await this.pc.setLocalDescription(offer)
		this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)))
		this.state = 'wait_for_webtc_answer'
	}
	
	async waitForWebRtcAnswer() {
		const [m, error] = await wait(this.ws)
		if (error) return
		const msg = JSON.parse(webwormhole.open(this.key, m.data))
		if (msg == null) {
			this.fail('bad key')
			this.ws.send(webwormhole.seal(this.key, 'bye'))
			return this.ws.close()
		}
		if (msg.type !== 'answer') {
			console.log('unexpected message', msg)
			return this.fail('unexpected message')
		}
		console.log('got answer')
		await this.pc.setRemoteDescription(new RTCSessionDescription(msg))
		this.phase3.resolve(webwormhole.fingerprint(this.key))
		this.state = 'wait_for_candidates'
	}

	async waitForCandidates() {
		const [m, error] = await wait(this.ws)
		if (error) return
		const msg = JSON.parse(webwormhole.open(this.key, m.data))
		if (msg == null) {
			this.fail('bad key')
			this.ws.send(webwormhole.seal(this.key, 'bye'))
			this.ws.close()
			return
		}
		console.log('got remote candidate', msg)
		return this.pc.addIceCandidate(new RTCIceCandidate(msg))
	}

	async waitForSlotB() {
		const [m, error] = await wait(this.ws)
		if (error) return
		const msg = JSON.parse(m.data)
		this.newPeerConnection(msg.iceServers)
		this.phase1.resolve({ pc: this.pc })
		const msgA = webwormhole.start(this.pass)
		if (msgA == null) return this.fail("couldn't generate A's PAKE message")
			
		console.log('message a:', msgA)
		this.ws.send(msgA)
		this.state = 'wait_for_pake_b'
	}

	async waitForPakeB() {
		const [m, error] = await wait(this.ws)
		if (error) return
		console.log('got pake message b:', m.data)
		this.key = webwormhole.finish(m.data)
		if (this.key == null) return this.fail('could not generate key')
		console.log('generated key')
		this.state = 'wait_for_webtc_offer'
	}

	async waitForWebRtcOffer() {
		const [m, error] = await wait(this.ws)
		if (error) return
		const msg = JSON.parse(webwormhole.open(this.key, m.data))
		if (msg == null) {
			this.fail('bad key')
			this.ws.send(webwormhole.seal(this.key, 'bye'))
			return this.ws.close()
		}

		if (msg.type !== 'offer') {
			console.log('unexpected message', msg)
			return this.fail('unexpected message')
		}
		console.log('got offer')
		// No intermediate state wait_for_pc_initialize because candidates can
		// start arriving straight after the offer is sent.
		// TODO: the above comment doesn't align as we do still wait for promise2?
		this.remoteDescription = msg
	}
	
	async createAnswer() {
		await this.pc.setRemoteDescription(new RTCSessionDescription(this.remoteDescription))
		const answer = await this.pc.createAnswer()
		await this.pc.setLocalDescription(answer)
		console.log('created answer')
		this.phase3.resolve(webwormhole.fingerprint(this.key))
		this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)))
		this.state = 'wait_for_candidates'
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
		this.pc = new RTCPeerConnection({ iceServers: normalisedICEServers });
		this.pc.onicecandidate = (e) => {
			if (e.candidate && e.candidate.candidate !== "") {
				console.log("got local candidate", e.candidate);
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
		const msg = 'could not connect to signalling server'
		this.fail(msg);
		if (this.phase1.isPending) this.phase1.reject(msg)
		if (this.phase3.isPending) this.phase3.reject(msg)
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
		if (this.phase1.isPending) this.phase1.reject(reason)
    	if (this.phase3.isPending) this.phase3.reject(reason)
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
