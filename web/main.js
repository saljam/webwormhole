import { goready, newwormhole, dial } from './dial.js';

// TODO multiple streams.
let receiving;
let sending;
let datachannel;

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

// receive is the new message handler.
//
// This function cannot be async without carefully thinking through the
// order of messages coming in.
let receive = e => {
	if (!receiving) {
		receiving = JSON.parse(new TextDecoder('utf8').decode(e.data));
		receiving.data = new Uint8Array(receiving.size);
		receiving.offset = 0;
		receiving.li = document.createElement('li');
		receiving.li.appendChild(document.createElement("a"));
		receiving.a = receiving.li.getElementsByTagName("a")[0];
		receiving.a.appendChild(document.createTextNode(`↓ ${receiving.name}`));
		receiving.li.appendChild(document.createElement('progress'));
		receiving.progress = receiving.li.getElementsByTagName("progress")[0];
		document.getElementById("transfers").appendChild(receiving.li);
		return
	}

	let data = new Uint8Array(e.data)
	receiving.data.set(data, receiving.offset);
	receiving.offset += data.length;
	receiving.progress.value = receiving.offset / receiving.size;

	if (receiving.offset > receiving.data.length) {
		throw "received more bytes than expected";
	}
	if (receiving.offset == receiving.data.length) {
		let blob = new Blob([receiving.data])
		receiving.a.href = URL.createObjectURL(blob);
		receiving.a.download = receiving.name;
		receiving.a.click();
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
			let [code, finish] = await newwormhole(pc);
			document.getElementById("magiccode").value = code;
			location.hash = code;
			let qr = util.qrencode(location.href);
			if (qr === null) {
				document.getElementById("qr").src = "";
			} else {
				document.getElementById("qr").src = URL.createObjectURL(new Blob([qr]));
			}
			await finish;
		} else {
			dialling();
			document.getElementById("info").innerHTML = "CONNECTING";
			await dial(pc, document.getElementById("magiccode").value);
		}
	} catch (err) {
		disconnected();
		if (err == "bad key") {
			document.getElementById("info").innerHTML = "BAD KEY TRY AGAIN";
		} else if (err == "no such slot") {
			document.getElementById("info").innerHTML = "NO SUCH SLOT";
		} else if (err == "timed out") {
			document.getElementById("info").innerHTML = "CODE TIMED OUT GENERATE ANOTHER";
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

let joining = () => {
	document.getElementById("magiccode").value = location.hash.substring(1);
	document.getElementById("dial").value = "JOIN WORMHOLE";
	connect();
}

let hashchange = e => {
	if (location.hash.substring(1) != "" && !(e.newURL && e.newURL.endsWith(document.getElementById("magiccode").value))) {
		joining();
	}
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
	window.addEventListener('hashchange', hashchange)
	await goready;
	if (document.getElementById("magiccode").value === "") {
		document.getElementById("dial").value = "NEW WORMHOLE";
	} else {
		document.getElementById("dial").value = "JOIN WORMHOLE";
	}
	if (location.hash.substring(1) != "") {
		joining();
	} else {
		document.getElementById("dial").disabled = false;
	}
});
