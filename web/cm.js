window.cm = {};

let ready = new Promise(async r => {
	const go = new Go();
	wasm = await WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject);
	go.run(wasm.instance);
	r();
})

cm.dial = async (slot, pass, pc) => {
	await ready;
	let candidates = new Promise(r=>{pc.onicecandidate=e=>{if(e.candidate === null){r()}}});
	let msgA = cm.start(pass)
	let response = await fetch(`https://minimumsignal.0f.io/${slot}`, {
		method: 'PUT',
		body: JSON.stringify({"msg":msgA})
	})
	if (response.status === 200) {
		// We're A side.
		let r = await response.json();
		let key = cm.finish(r.msg);
		let offer = JSON.parse(cm.open(key, r.secret));
		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		await pc.setLocalDescription(await pc.createAnswer());
		await candidates;
		await fetch(`https://minimumsignal.0f.io/${slot}`, {
			method: 'DELETE',
			body: JSON.stringify({"secret":cm.seal(key, JSON.stringify(pc.localDescription))}),
			headers: {'If-Match': response.headers.get('ETag')}
		});
		return "a";
	}
	if (response.status === 428) {
		// We're B side.
		let r = await response.json();
		let [key, msgA] = cm.exchange(pass, r.msg);
		await pc.setLocalDescription(await pc.createOffer())
		await candidates;
		response = await fetch(`https://minimumsignal.0f.io/${slot}`, {
			method: 'PUT',
			body: JSON.stringify({
				"secret":cm.seal(key, JSON.stringify(pc.localDescription)),
				"msg":msgA
			}),
			headers: {'If-Match': response.headers.get('ETag')}
		});
		r = await response.json();
		let answer = JSON.parse(cm.open(key, r.secret));
		await pc.setRemoteDescription(new RTCSessionDescription(answer));
		return "b";
	}
}
