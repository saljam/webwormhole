import { genpassword } from './wordlist.js';

const signalserver = ((location.protocol==="https:")?"wss://":"ws://")+location.host+"/s/";

export let goready = new Promise(async r => {
	if (!WebAssembly.instantiateStreaming) { // for Safari.
		WebAssembly.instantiateStreaming = async (resp, importObject) => {
			const source = await (await resp).arrayBuffer();
			return await WebAssembly.instantiate(source, importObject);
		};
	}
	const go = new Go();
	let wasm = await WebAssembly.instantiateStreaming(fetch("util.wasm"), go.importObject);
	go.run(wasm.instance);
	r();
});

// newwormhole creates wormhole, the A side.
export let newwormhole = async (pc) => {
	let ws = new WebSocket(signalserver);
	let key, slot, pass;
	let slotC, connC;
	let slotP = new Promise((resolve, reject) => {
		slotC = {resolve, reject};
	});
	let connP = new Promise((resolve, reject) => {
		connC = {resolve, reject};
	});
	ws.onmessage = async m => {
		if (!slot) {
			slot = m.data;
			pass = genpassword(2);
			console.log("assigned slot:", slot);
			slotC.resolve(slot + "-" + pass);
			return
		}
		if (!key) {
			console.log("got pake message a:", m.data);
			let msgB;
			[key, msgB] = util.exchange(pass, m.data);
			console.log("message b:", msgB);
			if (key == null) {
				connC.reject("couldn't generate key")
			}
			console.log("generated key");
			ws.send(msgB);
			pc.onicecandidate=e=>{
				if (e.candidate) {
					ws.send(util.seal(key, JSON.stringify(e.candidate)));
				}
			}
			await pc.setLocalDescription(await pc.createOffer());
			ws.send(util.seal(key, JSON.stringify(pc.localDescription)));
			return
		}
		let jsonmsg = util.open(key, m.data);
		if (jsonmsg === null) {
			// Auth failed. Send something so B knows.
			ws.send(util.seal(key, "bye"));
			ws.close();
			connC.reject("bad key")
			return
		}
		let msg = JSON.parse(jsonmsg);
		if (msg.type === "offer") {
			await pc.setRemoteDescription(new RTCSessionDescription(msg));
			await pc.setLocalDescription(await pc.createAnswer());
			ws.send(util.seal(key, JSON.stringify(pc.localDescription)))
			return
		}
		if (msg.type === "answer") {
			await pc.setRemoteDescription(new RTCSessionDescription(msg));
			return
		}
		if (msg.candidate) {
			pc.addIceCandidate(new RTCIceCandidate(msg));
			return
		}
		console.log("unknown message type", msg)
	}
	ws.onopen = e => {
		console.log("websocket session established")
	}
	ws.onerror = e => {
		connC.reject("couldn't connect to signalling server")
		console.log("websocket session error", e)
	}
	ws.onclose = e => {
		if (e.code === 404) {
			connC.reject("no such slot")
		} else if (e.code === 500) {
			connC.reject("couldn't get slot")
		} else if (e.code === 408) {
			connC.reject("timed out")
		} else {
			console.log("websocket session closed", e)
		}
	}

	return [await slotP, connP];
}

// dial joins a wormhole, the B side.
export let dial = async (pc, code) => {
	let [slot, ...passparts] = code.split("-");
	let pass = passparts.join("-");

	console.log("dialling slot:", slot);

	let ws = new WebSocket(signalserver+slot);
	let key;
	let connC;
	let connP = new Promise((resolve, reject) => {
		connC = {resolve, reject};
	});
	ws.onmessage = async m => {
		if (!key) {
			console.log("got pake message b:", m.data);
			key = util.finish(m.data);
			if (key == null) {
				connC.reject("couldn't generate key")
			}
			console.log("generated key");
			pc.onicecandidate=e=>{
				if (e.candidate) {
					ws.send(util.seal(key, JSON.stringify(e.candidate)));
				}
			}
			return
		}
		let jmsg = util.open(key, m.data);
		if (jmsg == null) {
			// Auth failed. Send something so A knows.
			ws.send(util.seal(key, "bye"));
			ws.close();
			connC.reject("bad key")
			return
		}
		let msg = JSON.parse(jmsg);
		if (msg.type === "offer") {
			await pc.setRemoteDescription(new RTCSessionDescription(msg));
			await pc.setLocalDescription(await pc.createAnswer());
			ws.send(util.seal(key, JSON.stringify(pc.localDescription)))
			return
		}
		if (msg.type === "answer") {
			await pc.setRemoteDescription(new RTCSessionDescription(msg));
			return
		}
		if (msg.candidate) {
			pc.addIceCandidate(new RTCIceCandidate(msg));
			return
		}
		console.log("unknown message type", msg)
	}
	ws.onopen = async e => {
		console.log("websocket opened")
		let msgA = util.start(pass)
		if (msgA == null) {
			connC.reject("couldn't generate A's PAKE message")
		}
		console.log("message a:", msgA);
		ws.send(msgA);
	}
	ws.onerror = e => {
		connC.reject("couldn't connect to signalling server")
		console.log("websocket session error", e)
	}
	ws.onclose = e => {
		if (e.code === 404) {
			connC.reject("no such slot")
		} else if (e.code === 500) {
			connC.reject("couldn't get slot")
		} else if (e.code === 408) {
			connC.reject("timed out")
		} else {
			console.log("websocket session closed", e)
		}
	}
	return await connP
}
