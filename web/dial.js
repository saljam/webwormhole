const signalserver = "/"; // relative URL, no CORS.

// TODO something nicer than this global?
// https://github.com/golang/go/issues/25612
export let goready = new Promise(async r => {
	if (!WebAssembly.instantiateStreaming) { // polyfill for Safari.
		WebAssembly.instantiateStreaming = async (resp, importObject) => {
			const source = await (await resp).arrayBuffer();
			return await WebAssembly.instantiate(source, importObject);
		};
	}
	const go = new Go();
	let wasm = await WebAssembly.instantiateStreaming(fetch("cryptowrap.wasm"), go.importObject);
	go.run(wasm.instance);
	r();
});

// newwormhole creates wormhole, the A side.
export let newwormhole = async (pc, pass) => {
	let candidates = collectcandidates(pc);
	let msgA = cryptowrap.start(pass)
	if (msgA == null) {
		throw "couldn't generate A's PAKE message";
	}
	let response = await fetch(signalserver, {
		method: 'POST',
		body: JSON.stringify({msgA})
	})
	if (response.status !== 200) {
		throw "couldn't reach signalling server";
	}
	let slot = response.headers.get("location").slice(1); // remove leading slash
	return [slot, new Promise(async (r, reject) => {
		let msg = await response.json();
		let key = cryptowrap.finish(msg.msgB);
		if (key == null) {
			reject("couldn't generate key");
		}
		let jsonoffer = cryptowrap.open(key, msg.offer)
		if (jsonoffer == null) {
			// Auth failed.
			// TODO We should still send a response so the other side knows.
			await fetch(signalserver+slot, {
				method: 'DELETE',
				body: JSON.stringify({answer:cryptowrap.seal(key,"bye")}),
				headers: {'If-Match': response.headers.get('ETag')}
			});
			reject("bad key");
			return;
		}
		let offer = JSON.parse(jsonoffer);
		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		await pc.setLocalDescription(await pc.createAnswer());
		await candidates;
		await fetch(signalserver+slot, {
			method: 'DELETE',
			body: JSON.stringify({answer:cryptowrap.seal(key, JSON.stringify(pc.localDescription))}), // probably ok
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
	let response = await fetch(signalserver+slot, {
		signal,
		method: 'PUT', // TODO dummy until server supports GET here
		body: ""
	})
	if (response.status !== 428) {
		controller.abort();
		throw "no such slot";
	}
	let msg = await response.json();
	let [key, msgB] = cryptowrap.exchange(pass, msg.msgA);
	if (key == null) {
		throw "couldn't generate key";
	}
	await pc.setLocalDescription(await pc.createOffer())
	await candidates;
	response = await fetch(signalserver+slot, {
		method: 'PUT',
		body: JSON.stringify({
			msgB,
			offer:cryptowrap.seal(key, JSON.stringify(pc.localDescription)) // also probably ok
		}),
		headers: {'If-Match': response.headers.get('ETag')}
	});
	msg = await response.json();
	let jsonanswer = cryptowrap.open(key, msg.answer)
	if (jsonanswer == null) {
		throw "bad key";
	}
	let answer = JSON.parse(jsonanswer);
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