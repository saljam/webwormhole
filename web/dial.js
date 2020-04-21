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
	let wasm = await WebAssembly.instantiateStreaming(fetch("util.wasm"), go.importObject);
	go.run(wasm.instance);
	r();
});

// newwormhole creates wormhole, the A side.
export let newwormhole = async (pc, pass) => {
	let candidates = collectcandidates(pc);
	let msgA = util.start(pass)
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

	let cont = async () => {
		let msg = await response.json();
		let key = util.finish(msg.msgB);
		if (key == null) {
			throw "couldn't generate key";
		}
		let jsonoffer = util.open(key, msg.offer)
		if (jsonoffer == null) {
			// Auth failed.
			await fetch(signalserver+slot, {
				method: 'DELETE',
				body: JSON.stringify({answer:util.seal(key,"bye")}),
				headers: {'If-Match': response.headers.get('ETag')}
			});
			throw "bad key";
		}
		let offer = JSON.parse(jsonoffer);
		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		await pc.setLocalDescription(await pc.createAnswer());
		await candidates;
		await fetch(signalserver+slot, {
			method: 'DELETE',
			body: JSON.stringify({answer:util.seal(key, JSON.stringify(pc.localDescription))}),
			headers: {'If-Match': response.headers.get('ETag')}
		});
	}

	return [slot, cont()];
}

// dial joins a wormhole, the B side.
export let dial = async (pc, slot, pass) => {
	let candidates = collectcandidates(pc);
	let response = await fetch(signalserver+slot)
	if (response.status !== 200) {
		throw "no such slot";
	}
	let msg = await response.json();
	let [key, msgB] = util.exchange(pass, msg.msgA);
	if (key == null) {
		throw "couldn't generate key";
	}
	await pc.setLocalDescription(await pc.createOffer())
	await candidates;
	response = await fetch(signalserver+slot, {
		method: 'PUT',
		body: JSON.stringify({
			msgB,
			offer:util.seal(key, JSON.stringify(pc.localDescription)) // also probably ok
		}),
		headers: {'If-Match': response.headers.get('ETag')}
	});
	msg = await response.json();
	let jsonanswer = util.open(key, msg.answer)
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