import { goready, newwormhole, dial } from './dial.js';
import { genpassword } from './wordlist.js';

const SW_PREFIX = '/_';

// TODO multiple streams.
let receiving;
let sending;
let datachannel;
let downloadServiceWorker; // Service worker managing download urls.

const serviceWorkerInUse = 'serviceWorker' in navigator;

if (serviceWorkerInUse) {
	navigator.serviceWorker.register('sw.js', {
		scope: `${SW_PREFIX}/`
	}).then(function(registration) {
		// TODO handle updates to service workers.
		downloadServiceWorker = registration.active || registration.waiting || registration.installing;
	});
}

let pick = e => {
	let files = document.getElementById("filepicker").files;
	for (let i = 0; i < files.length; i++) {
		send(files[i]);
	}
}

let drop = e => {
	let files = e.dataTransfer.files;
	for (let i = 0; i < files.length; i++) {
		send(files[i]);
	}
}

class DataChannelWriter {
	constructor(dc) {
		this.dc = dc;
		this.chunksize = 32<<10;
		this.bufferedAmountHighThreshold = 1<<20;
		this.dc.bufferedAmountLowThreshold = 512<<10;
		this.dc.onbufferedamountlow = () => {
			this.resolve()
		};
		this.ready = new Promise((resolve) => {
			this.resolve = resolve;
			this.resolve();
		});
	}
	async write(buf) {
		for (let offset = 0; offset < buf.length; offset += this.chunksize) {
			let end = offset+this.chunksize;
			if (end > buf.length) {
				end = buf.length;
			}
			await this.ready;
			this.dc.send(buf.subarray(offset, end));
		}
		if (this.dc.bufferedAmount >= this.bufferedAmountHighThreshold) {
			this.ready = new Promise((resolve) => this.resolve = resolve);
		}
	}
}

let send = async f => {
	if (sending) {
		console.log("haven't finished sending", sending.name);
		return
	}

	console.log("sending", f.name);
	datachannel.send(new TextEncoder('utf8').encode(JSON.stringify({
		name: f.name,
		size: f.size,
		type: f.type,
	})));

	sending = {f};
	sending.offset = 0;
	sending.li = document.createElement('li');
	sending.li.appendChild(document.createTextNode(`↑ ${f.name}`));
	sending.li.appendChild(document.createElement(`progress`));
	sending.progress = sending.li.getElementsByTagName("progress")[0];
	document.getElementById("transfers").appendChild(sending.li);

	let writer = new DataChannelWriter(datachannel);
	if (!f.stream) {
		// Hack around safari's lack of Blob.stream() and arrayBuffer().
		// This is unbenchmarked and could probably be made better.
		let read = b => {
			return new Promise(r => {
				let fr = new FileReader();
				fr.onload = (e) => {
					r(new Uint8Array(e.target.result));
				};
				fr.readAsArrayBuffer(b);
			});
		};
		const chunksize = 64<<10;
		while (sending.offset < f.size) {
			let end = sending.offset+chunksize
			if (end > f.size) {
				end = f.size;
			}
			await writer.write(await read(f.slice(sending.offset, end)));
			sending.offset = end;
			sending.progress.value = sending.offset / f.size;
		}
	} else {
		let reader = f.stream().getReader();
		while (true) {
			let { done, value } = await reader.read();
			if (done) {
				break;
			}
			await writer.write(value);
			sending.offset += value.length;
			sending.progress.value = sending.offset / f.size;
		}
	}
	sending.li.removeChild(sending.progress);
	sending = null;
}

let triggerDownload = receiving => {
	if (serviceWorkerInUse) {
		// `<a download=...>` doesn't work with service workers on Chrome yet.
		// See https://bugs.chromium.org/p/chromium/issues/detail?id=468227

		// Possible solutions:

		// - `window.open` is blocked as a popup.
		// window.open(`${SW_PREFIX}/${receiving.id}`);

		// - And this is quite scary but `Content-Disposition` to the rescue!
		//   It will navigate to 404 page if there is no service worker for some reason...
		//   But if `postMessage` didn't throw we should be safe.
		window.location = `${SW_PREFIX}/${receiving.id}`;

	} else {
		let blob = new Blob([receiving.data]);
		let a = document.createElement('a');
		a.href = URL.createObjectURL(blob); // TODO release this?
		a.download = receiving.name;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}
}

// receive is the new message handler.
//
// This function cannot be async without carefully thinking through the
// order of messages coming in.
let receive = e => {
	if (!receiving) {
		receiving = JSON.parse(new TextDecoder('utf8').decode(e.data));
		receiving.id = receiving.name +
			'-' + Math.random().toString(16).substring(2); // Strip leading '0.'.
		receiving.offset = 0;
		if (!serviceWorkerInUse)
			receiving.data = new Uint8Array(receiving.size);

		receiving.li = document.createElement('li');
		receiving.li.appendChild(document.createTextNode(`↓ ${receiving.name}`));
		receiving.li.appendChild(document.createElement('progress'));
		receiving.progress = receiving.li.getElementsByTagName("progress")[0];
		document.getElementById("transfers").appendChild(receiving.li);

		if (serviceWorkerInUse) {
			downloadServiceWorker.postMessage({
				id: receiving.id,
				type: 'metadata',
				name: receiving.name,
				size: receiving.size
			});
			triggerDownload(receiving);
		}

		return
	}

	let chunkSize = e.data.byteLength;

	if (receiving.offset + chunkSize > receiving.size) {
		let error = "received more bytes than expected";
		if (serviceWorkerInUse)
			downloadServiceWorker.postMessage({id: receiving.id, type: 'error', error});
		throw error;
	}

	if (serviceWorkerInUse) {
		downloadServiceWorker.postMessage({id: receiving.id, type: 'data', data: e.data}, [e.data]);
	} else {
		receiving.data.set(new Uint8Array(e.data), receiving.offset);
	}

	receiving.offset += chunkSize;
	receiving.progress.value = receiving.offset / receiving.size;

	if (receiving.offset == receiving.size) {
		if (serviceWorkerInUse) {
			downloadServiceWorker.postMessage({id: receiving.id, type: 'end'});
		} else {
			triggerDownload(receiving);
		}

		receiving.li.removeChild(receiving.progress);
		receiving = null;
	}
}

let connect = async e => {
	let pc = new RTCPeerConnection({"iceServers":[{"urls":"stun:stun.l.google.com:19302"}]});
	datachannel = pc.createDataChannel("data", {negotiated: true, id: 0});
	datachannel.onopen = connected;
	datachannel.onmessage = receive;
	datachannel.binaryType = "arraybuffer"
	datachannel.onclose = e => {
		disconnected();
		document.getElementById("info").innerHTML = "DISCONNECTED";
	};
	datachannel.onerror = e => {
		console.log("datachannel error:", e);
		disconnected();
		document.getElementById("info").innerHTML = "NETWORK ERROR TRY AGAIN";
	};
	try {
		if (document.getElementById("magiccode").value === "") {
			dialling();
			document.getElementById("info").innerHTML = "WAITING FOR THE OTHER SIDE - SHARE CODE OR URL";

			// TODO move this logic to wormhole package.
			let pass = genpassword(2);
			let [slot, c] = await newwormhole(pc, pass);
			let code = slot + "-" + pass;

			console.log ("assigned slot", slot, "pass", pass);
			document.getElementById("magiccode").value = code;
			location.hash = code;

			let qr = util.qrencode(location.href);
			if (qr === null) {
				document.getElementById("qr").src = "";
			} else {
				document.getElementById("qr").src = URL.createObjectURL(new Blob([qr]));
			}

			await c;
		} else {
			dialling();
			document.getElementById("info").innerHTML = "CONNECTING";

			// TODO move this logic to wormhole package.
			let [slot, ...passparts] = document.getElementById("magiccode").value.split("-");
			let pass = passparts.join("-");
			console.log("dialling slot", slot, "pass", pass);

			await dial(pc, slot, pass);
		}
	} catch (err) {
		disconnected();
		if (err == "bad key") {
			document.getElementById("info").innerHTML = "BAD KEY TRY AGAIN";
		} else {
			document.getElementById("info").innerHTML = "COULD NOT CONNECT TRY AGAIN";
		}
	}
}

let dialling = () => {
	document.body.classList.add("dialling");
	document.body.classList.remove("connected");
	document.body.classList.remove("disconnected");

	document.getElementById("dial").disabled = true;
	document.getElementById("magiccode").readOnly = true;
}

let connected = () => {
	document.body.classList.remove("dialling");
	document.body.classList.add("connected");
	document.body.classList.remove("disconnected");

	document.body.addEventListener('drop', drop);
	document.body.addEventListener('dragenter', highlight);
	document.body.addEventListener('dragover', highlight);
	document.body.addEventListener('drop', unhighlight);
	document.body.addEventListener('dragleave', unhighlight);

	document.getElementById("info").innerHTML = "OR DRAG FILES TO SEND";

	location.hash = "";
}

let disconnected = () => {
	document.body.classList.remove("dialling");
	document.body.classList.remove("connected");
	document.body.classList.add("disconnected");

	document.getElementById("dial").disabled = false;
	document.getElementById("magiccode").readOnly = false;
	document.getElementById("magiccode").value = ""

	document.body.removeEventListener('drop', drop);
	document.body.removeEventListener('dragenter', highlight);
	document.body.removeEventListener('dragover', highlight);
	document.body.removeEventListener('drop', unhighlight);
	document.body.removeEventListener('dragleave', unhighlight);

	location.hash = "";

	if (serviceWorkerInUse && receiving)
		downloadServiceWorker.postMessage({id: receiving.id, type: 'error', error: 'rtc disconnected'});
}

let highlight = e => {
	document.body.classList.add("highlight");
}

let unhighlight = e => {
	document.body.classList.remove("highlight");
}

let preventdefault = e => {
	e.preventDefault()
	e.stopPropagation()
}

document.addEventListener('DOMContentLoaded', async () => {
	document.getElementById("magiccode").value = "";
	document.getElementById("magiccode").addEventListener('input', async ()=>{
		await goready;
		if (document.getElementById("magiccode").value === "") {
			document.getElementById("dial").value = "NEW WORMHOLE";
		} else {
			document.getElementById("dial").value = "JOIN WORMHOLE";
		}
	});
	document.getElementById("filepicker").addEventListener('change', pick);
	document.getElementById("dialog").addEventListener('submit', preventdefault);
	document.getElementById("dialog").addEventListener('submit', connect);
	document.body.addEventListener('drop', preventdefault);
	document.body.addEventListener('dragenter', preventdefault);
	document.body.addEventListener('dragover', preventdefault);
	document.body.addEventListener('drop', preventdefault);
	document.body.addEventListener('dragleave', preventdefault);
	await goready;
	if (document.getElementById("magiccode").value === "") {
		document.getElementById("dial").value = "NEW WORMHOLE";
	} else {
		document.getElementById("dial").value = "JOIN WORMHOLE";
	}
	if (location.hash.substring(1) != "") {
		document.getElementById("magiccode").value = location.hash.substring(1);
		document.getElementById("dial").value = "JOIN WORMHOLE";
		connect();
	} else {
		document.getElementById("dial").disabled = false;
	}
});
