window.cm = {};

// TODO block the dial functions until this is done.
const go = new Go();
WebAssembly.instantiateStreaming(fetch("crypto.wasm"), go.importObject).then(r=>{go.run(r.instance)});

const signalserver = `https://minimumsignal.0f.io/`;
let cm = window.cm;

// newwormhole creates wormhole, the A side.
export let newwormhole = async (pc, pass) => {
	let candidates = collectcandidates(pc);
	let msgA = cm.start(pass)
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
		let key = cm.finish(msg.msgB);
		let offer = JSON.parse(cm.open(key, msg.offer));
		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		await pc.setLocalDescription(await pc.createAnswer());
		await candidates;
		await fetch(signalserver + `${slot}`, {
			method: 'DELETE',
			body: JSON.stringify({answer:cm.seal(key, JSON.stringify(pc.localDescription))}),
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
	let [key, msgB] = cm.exchange(pass, msg.msgA);
	await pc.setLocalDescription(await pc.createOffer())
	await candidates;
	response = await fetch(signalserver + `${slot}`, {
		method: 'PUT',
		body: JSON.stringify({
			offer:cm.seal(key, JSON.stringify(pc.localDescription)),
			msgB
		}),
		headers: {'If-Match': response.headers.get('ETag')}
	});
	msg = await response.json();
	let answer = JSON.parse(cm.open(key, msg.answer));
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