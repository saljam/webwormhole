const signalserver = "https://minimumsignal.0f.io/";

// TODO something nicer than this global?
// https://github.com/golang/go/issues/25612
window.cm = {};
export let goready = new Promise(async r => {
	// Polyfill https://github.com/golang/go/blob/b2fcfc1a50fbd46556f7075f7f1fbf600b5c9e5d/misc/wasm/wasm_exec.html#L17-L22
	if (!WebAssembly.instantiateStreaming) {
		WebAssembly.instantiateStreaming = async (resp, importObject) => {
			const source = await (await resp).arrayBuffer();
			return await WebAssembly.instantiate(source, importObject);
		};
	}
	const go = new Go();
	let wasm = await WebAssembly.instantiateStreaming(fetch("crypto.wasm"), go.importObject);
	go.run(wasm.instance);
	r();
});

// TODO learn how to handle errors in js.

// newwormhole creates wormhole, the A side.
export let newwormhole = async (pc, pass) => {
	let candidates = collectcandidates(pc);
	let msgA = window.cm.start(pass)
	let response = await fetch(signalserver, {
		method: 'POST',
		body: JSON.stringify({msgA})
	})
	if (response.status !== 200) {
		return // TODO raise error
	}
	let slot = response.headers.get("location").slice(1); // remove leading slash
	return [slot, new Promise(async r=>{
		let msg = await response.json();
		let key = window.cm.finish(msg.msgB);
		let offer = JSON.parse(window.cm.open(key, msg.offer));
		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		await pc.setLocalDescription(await pc.createAnswer());
		await candidates;
		await fetch(signalserver + `${slot}`, {
			method: 'DELETE',
			body: JSON.stringify({answer:window.cm.seal(key, JSON.stringify(pc.localDescription))}),
			headers: {'If-Match': response.headers.get('ETag')}
		});
		r();
	})];
}

// dial joins a wormhole, the B side.
export let dial = async (pc, slot, pass) => {
	let candidates = collectcandidates(pc);
	const controller = new AbortController();
	const { signal } = controller;
	let response = await fetch(`https://minimumsignal.0f.io/${slot}`, {
		signal,
		method: 'PUT', // dummy until server supports GET here
		body: ""
	})
	if (response.status !== 428) {
		controller.abort();
		return
	}
	let msg = await response.json();
	let [key, msgB] = window.cm.exchange(pass, msg.msgA);
	await pc.setLocalDescription(await pc.createOffer())
	await candidates;
	response = await fetch(signalserver + `${slot}`, {
		method: 'PUT',
		body: JSON.stringify({
			offer:window.cm.seal(key, JSON.stringify(pc.localDescription)),
			msgB
		}),
		headers: {'If-Match': response.headers.get('ETag')}
	});
	msg = await response.json();
	let answer = JSON.parse(window.cm.open(key, msg.answer));
	await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

// collectcandidates returns a promise that's resolved when pc has gathered all its candidates
let collectcandidates = pc => {
	return new Promise(r=>{
		pc.onicecandidate=e=>{
			if (e.candidate === null) {
				r();
			}
		}
	});
}