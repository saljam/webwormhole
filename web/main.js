import { goready, newwormhole, dial } from './dial.js';
import { genpassword } from './wordlist.js';

// TODO multiple streams.
// TODO have less of a global mess here. Maybe a "transfers" object for
// transfers in progress? Each could be mapped to a different datachannel
// there too, new object instantiated by ondatachannel callback.
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

let send = async f => {
	if (sending) {
		console.log("haven't finished sending", sending.name);
		return
	}
	console.log("sending", f.name);
	datachannel.send(JSON.stringify({
		name: f.name,
		size: f.size,
		type: f.type,
	}));
	// TODO progress bar. https://developer.mozilla.org/en-US/docs/Web/HTML/Element/progress

	const chunksize = 16<<10
	datachannel.bufferedAmountLowThreshold = 2 * chunksize;
	// TODO apparently ios safari does not have onbufferedamountlow. fallback to
	// something else?

	sending = f;
	sending.offset = 0;
	let reader = f.stream().getReader()
	datachannel.onbufferedamountlow = async () => {
		let { done, value } = await reader.read();
		if (done) {
			console.log("send complete");
			sending = null;
			return;
		}
		for (let offset = 0; offset < value.length; offset += chunksize) {
			const n = offset+chunksize > value.length? value.length : offset+chunksize;
			datachannel.send(value.subarray(offset, n));
		}
		if (value.length <= datachannel.bufferedAmountLowThreshold) {
			// This won't trigger the callback again. Try to read more.
			datachannel.onbufferedamountlow();
		}
	};
	datachannel.onbufferedamountlow(); // start it off.
}

let receive = async e => {
	// TODO ensure the type is always sent as one of these.
	let data;
	if (e.data instanceof ArrayBuffer) {
		data = new Uint8Array(e.data);
	} else if (e.data instanceof Blob) {
		data = new Uint8Array(await e.data.arrayBuffer());
	} else if (typeof e.data === "string"){
		let encoder = new TextEncoder('utf8');
		data = encoder.encode(e.data);
	} else {
		console.log("unknown type")
		console.log(e.data)
		return
	}

	if (!receiving) {
		let decoder = new TextDecoder('utf8');
		receiving = JSON.parse(decoder.decode(data));
		receiving.data = new Uint8Array(receiving.size);
		receiving.offset = 0;
		return
	}

	receiving.data.set(data, receiving.offset);
	receiving.offset += data.length;

	if (receiving.offset > receiving.data.length) {
		console.log("PANIC received more bytes than expecting")
	}
	if (receiving.offset == receiving.data.length) {
		let blob = new Blob([receiving.data])
		let a = document.createElement('a');
		a.href = window.URL.createObjectURL(blob); // TODO release this.
		a.download = receiving.name;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		receiving = null;
	}
}

let connect = async e => {
	let pc = new RTCPeerConnection({"iceServers":[{"urls":"stun:stun.l.google.com:19302"}]});
	datachannel = pc.createDataChannel("data", {negotiated: true, id: 0});
	datachannel.onopen = connected;
	datachannel.onmessage = receive;
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
			document.getElementById("info").innerHTML = "WAITING FOR THE OTHER SIDE";
			let pass = genpassword(2);
			let [slot, c] = await newwormhole(pc, pass);
			console.log ("assigned slot", slot, "pass", pass);
			document.getElementById("magiccode").value = slot + "-" + pass;
			await c;
		} else {
			dialling();
			document.getElementById("info").innerHTML = "CONNECTING";
			let [slot, ...passparts] = document.getElementById("magiccode").value.split("-");
			let pass = passparts.join("-");
			console.log("dialling slot", slot, "pass", pass);
			await dial(pc, slot, pass);
		}
	} catch (err) {
		console.log("handshake error:", err);
		disconnected();
		if (err == "bad key") {
			document.getElementById("info").innerHTML = "BAD KEY TRY AGAIN";
		} else if (err == "// TODO TIMEOUT / CANCELLATION") {
			document.getElementById("info").innerHTML = "TIMED OUT TRY AGAIN";
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
	document.getElementById("filepicker").addEventListener('change', pick);
	document.getElementById("dialog").addEventListener('submit', preventdefault);
	document.getElementById("dialog").addEventListener('submit', connect);
	document.body.addEventListener('drop', preventdefault);
	document.body.addEventListener('dragenter', preventdefault);
	document.body.addEventListener('dragover', preventdefault);
	document.body.addEventListener('drop', preventdefault);
	document.body.addEventListener('dragleave', preventdefault);
	await goready;
	document.getElementById("dial").disabled = false;
});
