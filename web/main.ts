/// <reference path="ww.ts" />

// Declare Clipboard API types, which don't exist in TypeScript yet.
// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard
interface Clipboard {
	read(): Promise<ClipboardItem[]>;
}
interface ClipboardItem {
	types: string[];
	getType(mimeType: string): Blob;
}

// Declare just enough of the extensions API to find out if we're
// running in the context of one.
interface Window {
	chrome: typeof chrome;
}
declare namespace chrome.runtime {
	export function getURL(path: string): string;
}

// Flags corresponding to browser specific quirks.
const hacks: Record<string, boolean> = {};

// receiving is the object currently being received.
let receiving: Receiver | undefined;

// sending is the object currently being sent.
let sending: Upload | undefined;

// sendqueue is the queue of objects waiting to be sent.
let sendqueue: Upload[] = [];

// state is the top-level connection state.
let state: "disconnected" | "dialling" | "connected" = "disconnected";

// datachannel is the active datachannel, if we're connected.
let datachannel: RTCDataChannel | null;

// serviceworker is the helper download service worker, if enabled.
let serviceworker: ServiceWorker | null;

// signalserver is the address of the signalling server.
let signalserver: URL = new URL(location.href);

// peerconnection is the active connection's WebRTC object. Global to help debugging.
let peerconnection: RTCPeerConnection | null;

// UI elements.
let filepicker: HTMLInputElement;
let dialButton: HTMLInputElement;
let phraseInput: HTMLInputElement;
let clipboardInput: HTMLInputElement;
let mainForm: HTMLFormElement;
let qrImg: HTMLImageElement;
let transfersList: HTMLElement;
let infoBox: HTMLElement;
let autocompleteBox: HTMLElement;

// The structure of the header message sent on the wire before a
// file's data.
interface FileHeader {
	name: string;
	type: string;
	size: number;
}

interface Receiver {
	receive(e: MessageEvent): void;
	done(): boolean;
	cancel(): void;

	li: HTMLElement;
	a: HTMLAnchorElement;
	progress: HTMLProgressElement;
}

class DataChannelWriter {
	dc: RTCDataChannel;

	chunksize = 32 << 10;
	bufferedAmountHighThreshold = 1 << 20;
	bufferedAmountLowThreshold = 1 << 20;

	ready: Promise<void>;
	resolve?: () => void;

	constructor(dc: RTCDataChannel) {
		this.dc = dc;
		this.dc.bufferedAmountLowThreshold = this.bufferedAmountLowThreshold;
		this.dc.onbufferedamountlow = () => {
			if (this.resolve) this.resolve();
		};
		this.ready = new Promise((resolve) => {
			this.resolve = resolve; // TODO needed?
			this.resolve();
		});
	}

	async write(buf: Uint8Array) {
		for (let offset = 0; offset < buf.length; offset += this.chunksize) {
			let end = offset + this.chunksize;
			if (end > buf.length) {
				end = buf.length;
			}
			await this.ready;
			this.dc.send(buf.subarray(offset, end));
		}
		if (this.dc.bufferedAmount >= this.bufferedAmountHighThreshold) {
			this.ready = new Promise((resolve) => {
				this.resolve = resolve;
			});
		}
	}
}

class Upload {
	header: FileHeader;
	blob?: Blob;
	stream?: ReadableStream;
	offset = 0;

	li: HTMLElement = document.createElement("li");
	progress: HTMLProgressElement = document.createElement("progress");

	constructor(header: FileHeader, data: Blob | ReadableStream) {
		this.header = header;
		if (data instanceof ReadableStream) {
			this.stream = data;
		} else {
			this.blob = data;
			if (data.stream) {
				this.stream = data.stream();
			}
		}
	}

	async send(dc: RTCDataChannel) {
		console.log("sending", this.header.name, this.header.type);
		this.li.classList.remove("pending");
		this.li.classList.add("upload");
		this.li.appendChild(document.createElement("progress"));
		this.progress = this.li.getElementsByTagName("progress")[0];

		dc.send(new TextEncoder().encode(JSON.stringify(this.header)));

		const writer = new DataChannelWriter(dc);
		if (this.stream) {
			const reader = this.stream.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				await writer.write(value);
				this.offset += value.length;
				this.progress.value = this.offset / this.header.size;
			}
			this.li.removeChild(this.progress);
			return;
		}

		if (this.blob) {
			// Backwards compatability with browsers that don't have Blob.stream. (Safari pre-14.1)
			function read(b: Blob): Promise<Uint8Array> {
				return new Promise((resolve) => {
					const fr = new FileReader();
					fr.onload = () => {
						resolve(new Uint8Array(fr.result as ArrayBuffer));
					};
					fr.readAsArrayBuffer(b);
				});
			}
			const chunksize = 64 << 10;
			while (this.offset < this.header.size) {
				let end = this.offset + chunksize;
				if (end > this.blob.size) {
					end = this.blob.size;
				}
				await writer.write(await read(this.blob.slice(this.offset, end)));
				this.offset = end;
				this.progress.value = this.offset / this.blob.size;
			}
			this.li.removeChild(this.progress);
			return;
		}
	}
}

class ServiceWorkerDownload {
	header: FileHeader;
	id: string;
	sw: ServiceWorker;
	offset = 0;

	li: HTMLElement = document.createElement("li");
	a: HTMLAnchorElement = document.createElement("a");
	progress: HTMLProgressElement = document.createElement("progress");

	constructor(sw: ServiceWorker, header: FileHeader) {
		this.sw = sw;
		this.header = header;
		(this.id = `${Math.random().toString(16).substring(2)}-${encodeURIComponent(
			header.name
		)}`),
			this.a.appendChild(document.createTextNode(`${header.name}`));
		this.li.appendChild(this.a);
		this.li.appendChild(this.progress);
		this.li.classList.add("download");
		transfersList.appendChild(this.li);

		sw.postMessage({
			id: this.id,
			type: "metadata", // TODO rename this to not clash with header.type
			name: header.name,
			size: header.size,
			filetype: header.type,
		});

		this.triggerDownload();
	}

	receive(e: MessageEvent) {
		const chunkSize = e.data.byteLength;

		if (this.offset + chunkSize > this.header.size) {
			const error = "received more bytes than expected";
			this.sw.postMessage({ id: this.id, type: "error", error });
			throw error;
		}

		this.sw.postMessage(
			{
				id: this.id,
				type: "data",
				data: e.data,
				offset: this.offset,
			},
			[e.data]
		);

		this.offset += chunkSize;
		this.progress.value = this.offset / this.header.size;

		if (this.done()) {
			this.sw.postMessage({ id: this.id, type: "end" });
			this.li.removeChild(this.progress);
		}
	}

	done() {
		return this.offset === this.header.size;
	}

	cancel() {
		this.sw.postMessage({
			id: this.id,
			type: "error",
			error: "rtc disconnected",
		});
	}

	triggerDownload() {
		// `<a download=...>` doesn't work with service workers on Chrome yet.
		// See https://bugs.chromium.org/p/chromium/issues/detail?id=468227
		//
		// Possible solutions:
		//
		// - `window.open` is blocked as a popup.
		// window.open(`${SW_PREFIX}/${this.id}`);
		//
		// - And this is quite scary but `Content-Disposition` to the rescue!
		//   It will navigate to 404 page if there is no service worker for some reason...
		//   But if `postMessage` didn't throw we should be safe.
		window.location.assign(`/_/${this.id}`);
	}
}

class ArrayBufferDownload {
	header: FileHeader;
	data: Uint8Array;
	offset = 0;

	li: HTMLElement = document.createElement("li");
	a: HTMLAnchorElement = document.createElement("a");
	progress: HTMLProgressElement = document.createElement("progress");

	constructor(header: FileHeader) {
		this.header = header;
		this.data = new Uint8Array(header.size);
		this.a.appendChild(document.createTextNode(`${header.name}`));
		this.li.appendChild(this.a);
		this.li.appendChild(this.progress);
		this.li.classList.add("download");
		transfersList.appendChild(this.li);
	}

	receive(e: MessageEvent) {
		const chunkSize = e.data.byteLength;

		if (this.offset + chunkSize > this.header.size) {
			const error = "received more bytes than expected";
			throw error;
		}

		this.data.set(new Uint8Array(e.data), this.offset);
		this.offset += chunkSize;
		this.progress.value = this.offset / this.header.size;

		if (this.done()) {
			this.triggerDownload();
			this.li.removeChild(this.progress);
		}
	}

	done() {
		return this.offset === this.header.size;
	}

	cancel() {}

	triggerDownload() {
		if (hacks.noblob) {
			const blob = new Blob([this.data], { type: this.header.type });
			const fr = new FileReader();
			fr.onloadend = () => {
				this.a.href = fr.result as string;
				this.a.download = this.header.name;
			};
			fr.readAsDataURL(blob);
			return;
		}

		const blob = new Blob([this.data], { type: this.header.type });
		this.a.href = URL.createObjectURL(blob);
		this.a.download = this.header.name;
		this.a.click();
	}
}

function pick() {
	if (!filepicker.files) {
		return;
	}
	for (let i = 0; i < filepicker.files.length; i++) {
		sendfile(filepicker.files[i]);
	}
}

function drop(e: DragEvent) {
	if (!e.dataTransfer) {
		return;
	}
	const files = e.dataTransfer.files;
	const t = e.dataTransfer.getData("text");
	if (files.length !== 0) {
		for (let i = 0; i < files.length; i++) {
			sendfile(files[i]);
		}
	} else if (t.length !== 0) {
		sendtext(t);
	}

	// A shortcut to save users a click. If we're disconnected and they drag
	// a file in treat it as a click on the new/join wormhole button.
	if (state === "disconnected") {
		connect();
	}
}

// Handle a paste event from cmd-v/ctl-v.
function pasteEvent(e: ClipboardEvent) {
	if (!e.clipboardData) {
		return;
	}
	const files = e.clipboardData.files;
	const t = e.clipboardData.getData("text");
	if (files.length !== 0) {
		for (let i = 0; i < files.length; i++) {
			sendfile(files[i]);
		}
	} else if (t.length !== 0) {
		sendtext(t);
	}
}

// Read clipboard content using Clipboard API.
async function pasteClipboard() {
	if (hacks.noclipboardapi) {
		return;
	}

	let items = await navigator.clipboard.read();

	// TODO toast a message if permission wasn't given.
	for (let i = 0; i < items.length; i++) {
		if (items[i].types.includes("image/png")) {
			const blob = await items[i].getType("image/png");
			sendfile(new File([blob], "image.png"));
		} else if (items[i].types.includes("text/plain")) {
			const blob = await items[i].getType("text/plain");
			sendtext(await blob.text());
		}
	}
}

async function sendtext(msg: string) {
	const item = new Upload(
		{
			name: msg,
			type: "application/webwormhole-text",
			size: 0,
		},
		new Blob([])
	);
	item.li.classList.add("pending");
	item.li.appendChild(
		document.createElement("pre").appendChild(document.createTextNode(`${msg}`))
	);
	transfersList.appendChild(item.li);
	send(item);
}

async function sendfile(f: File) {
	const item = new Upload(
		{
			name: f.name,
			type: f.type,
			size: f.size,
		},
		f
	);
	item.li.classList.add("pending");
	item.li.innerText = `${f.name}`;
	transfersList.appendChild(item.li);
	send(item);
}

async function send(item?: Upload) {
	if (item) {
		sendqueue.push(item);
	}
	if (!datachannel) {
		console.log("adding to queue: not connected");
		return;
	}
	if (sending) {
		console.log("adding to queue: haven't finished sending current file");
		return;
	}
	while ((sending = sendqueue.shift())) {
		await sending.send(datachannel);
		sending = undefined;
	}
}

function receive(e: MessageEvent) {
	if (receiving) {
		receiving.receive(e);
		if (receiving.done()) {
			receiving = undefined;
		}
		return;
	}

	const header = JSON.parse(
		new TextDecoder("utf8").decode(e.data)
	) as FileHeader;

	// Special case raw text that's been received.
	if (header.type === "application/webwormhole-text") {
		const li = document.createElement("li");
		li.appendChild(
			document
				.createElement("pre")
				.appendChild(document.createTextNode(`${header.name}`))
		);
		li.classList.add("download");
		transfersList.appendChild(li);
		return;
	}

	if (serviceworker) {
		receiving = new ServiceWorkerDownload(serviceworker, header);
	} else {
		receiving = new ArrayBufferDownload(header);
	}
}

async function connect() {
	try {
		dialling();

		const w = new Wormhole(signalserver.href, phraseInput.value);

		w.callback = (pc: RTCPeerConnection, code?: string) => {
			if (code) {
				waiting();
				codechange();
				phraseInput.value = code;
				location.hash = code;
				signalserver.hash = code;
				updateqr(signalserver.href);
			}

			peerconnection = pc;

			// Use PeerConnection.iceConnectionState since Firefox does not
			// implement PeerConnection.connectionState
			pc.oniceconnectionstatechange = () => {
				switch (pc.iceConnectionState) {
					case "connected": {
						// Handled in datachannel.onopen.
						w.close();
						break;
					}
					case "disconnected":
					case "closed": {
						disconnected("webrtc connection closed");
						pc.onconnectionstatechange = null;
						break;
					}
					case "failed": {
						disconnected("webrtc connection failed");
						console.log(
							"webrtc connection failed connectionState:",
							pc.connectionState,
							"iceConnectionState",
							pc.iceConnectionState
						);
						w.close();
						break;
					}
				}
			};

			const dc = pc.createDataChannel("data", { negotiated: true, id: 0 });
			dc.onopen = () => {
				connected();
				datachannel = dc;
				// Send anything we have waiting in the send queue.
				send();
			};
			dc.onmessage = receive;
			dc.binaryType = "arraybuffer";
			dc.onclose = () => {
				disconnected("datachannel closed");
			};
			dc.onerror = (e) => {
				disconnected(`datachannel error: ${e.error}`);
			};
		};

		const fingerprint = await w.dial();

		// To make it more likely to spot the 1 in 2^16 chance of a successful
		// MITM password guess, we can compare a fingerprint derived from the PAKE
		// key. The 7 words visible on the tooltip of the input box should match on
		// both side.
		// We also use the first 3 bits of it to choose the background colour, so
		// that should match on both sides as well.
		const encodedfp = webwormhole.encode(0, fingerprint.subarray(1));
		phraseInput.title = encodedfp.substring(encodedfp.indexOf("-") + 1);
		document.body.style.backgroundColor = `var(--palette-${
			fingerprint[0] % 8
		})`;
	} catch (err) {
		disconnected(err);
	}
}

function waiting() {
	infoBox.innerText =
		"Waiting for the other side to join by typing the wormhole phrase, opening this URL, or scanning the QR code.";
}

function dialling() {
	state = "dialling";
	infoBox.innerText = "Connecting...";

	document.body.classList.add("dialling");
	document.body.classList.remove("connected");
	document.body.classList.remove("disconnected");

	filepicker.disabled = false;
	clipboardInput.disabled = false || hacks.noclipboardapi;
	dialButton.disabled = true;
	phraseInput.readOnly = true;
	document.body.addEventListener("paste", pasteEvent);
}

function connected() {
	state = "connected";
	infoBox.innerText = "";

	document.body.classList.remove("dialling");
	document.body.classList.add("connected");
	document.body.classList.remove("disconnected");

	location.hash = "";
}

function disconnected(reason: string) {
	state = "disconnected";
	datachannel = null;
	sendqueue = [];
	document.body.style.backgroundColor = "";

	// TODO better error types or at least hoist the strings to consts.
	if (reason === "bad key") {
		infoBox.innerText = "Wrong wormhole phrase.";
	} else if (reason === "bad code") {
		infoBox.innerText = "Not a valid wormhole phrase.";
	} else if (reason === "no such slot") {
		infoBox.innerText = "No such slot. The wormhole might have expired.";
	} else if (reason === "timed out") {
		infoBox.innerText = "Wormhole expired.";
	} else if (reason === "could not connect to signalling server") {
		infoBox.innerText =
			"Could not reach the signalling server. Refresh page and try again.";
	} else if (reason === "webrtc connection closed") {
		infoBox.innerText = "Disconnected.";
	} else if (reason === "webrtc connection failed") {
		infoBox.innerText = "Network error.";
	} else if (reason === "datachannel closed") {
		infoBox.innerText = "Disconnected.";
	} else if (reason === "webrtc connection failed") {
		infoBox.innerText = "Network error.";
	} else {
		infoBox.innerText = "Could not connect.";
		console.log(reason);
	}

	document.body.classList.remove("dialling");
	document.body.classList.remove("connected");
	document.body.classList.add("disconnected");

	filepicker.disabled = true;
	clipboardInput.disabled = true;
	document.body.removeEventListener("paste", pasteEvent);
	dialButton.disabled = false;
	phraseInput.readOnly = false;
	phraseInput.value = "";
	codechange();
	updateqr("");

	location.hash = "";

	if (receiving) {
		receiving.cancel();
		receiving = undefined;
	}
}

function highlight() {
	document.body.classList.add("highlight");
}

function unhighlight() {
	document.body.classList.remove("highlight");
}

function preventdefault(e: Event) {
	e.preventDefault();
	e.stopPropagation();
}

async function copyurl() {
	await navigator.clipboard.writeText(signalserver.href);
	// TODO toast message on success.
}

function updateqr(url: string) {
	const qr = webwormhole.qrencode(url);
	if (url === "" || qr === null) {
		qrImg.src = "";
		qrImg.alt = "";
		qrImg.title = "";
	} else {
		qrImg.src = URL.createObjectURL(new Blob([qr]));
		qrImg.alt = url;
		qrImg.title = `${url} - double click to copy`;
	}
}

function hashchange() {
	const newhash = location.hash.substring(1);
	if (newhash !== "" && newhash !== phraseInput.value) {
		console.log("hash changed dialling new code");
		phraseInput.value = newhash;
		codechange();
		connect();
	}
}

function codechange() {
	if (phraseInput.value === "") {
		dialButton.value = "CREATE WORMHOLE";
	} else {
		dialButton.value = "JOIN WORMHOLE";
	}
}

function autocompletehint() {
	const words = phraseInput.value.split("-");
	const prefix = words[words.length - 1];
	const hint = webwormhole.match(prefix);
	autocompleteBox.innerText = hint;
}

function autocomplete(e: KeyboardEvent) {
	// TODO more stateful autocomplete, i.e. repeated tabs cycle through matches.
	if (e.keyCode === 9) {
		e.preventDefault(); // Prevent tabs from doing tab things.
		const words = phraseInput.value.split("-");
		const prefix = words[words.length - 1];
		const hint = webwormhole.match(prefix);
		if (hint === "") {
			return;
		}
		phraseInput.value += `${hint.substring(prefix.length)}-`;
		autocompleteBox.innerText = "";
	}
}

function browserhacks() {
	// Detect for features we need for this to work.
	if (!window.WebSocket || !window.RTCPeerConnection || !window.WebAssembly) {
		hacks.browserunsupported = true;
		hacks.nosw = true;
		hacks.nowasm = true;
		console.log("quirks: browser not supported");
		console.log(
			"websocket:",
			!!window.WebSocket,
			"webrtc:",
			!!window.RTCPeerConnection,
			"wasm:",
			!!window.WebAssembly
		);
		return;
	}

	// Polyfill for Safari WASM streaming.
	if (!WebAssembly.instantiateStreaming) {
		WebAssembly.instantiateStreaming = async (resp, importObject) => {
			const source = await (await resp).arrayBuffer();
			return await WebAssembly.instantiate(source, importObject);
		};
		console.log("quirks: using wasm streaming polyfill");
	}

	// Safari cannot save files from service workers.
	if (
		/Safari/.test(navigator.userAgent) &&
		!(
			/Chrome/.test(navigator.userAgent) || /Chromium/.test(navigator.userAgent)
		)
	) {
		hacks.nosw = true;
		console.log("quirks: serviceworkers disabled on safari");
	}

	if (!navigator.serviceWorker) {
		hacks.nosw = true;
		console.log("quirks: no serviceworkers");
	}

	// Work around iOS Safari <= 12 not being able to download blob URLs.
	// This can die when iOS Safari usage is less than 1% on this table:
	// https://caniuse.com/usage-table
	hacks.noblob = false;
	if (
		/^Mozilla\/5.0 \(iPhone; CPU iPhone OS 12_[0-9]_[0-9] like Mac OS X\)/.test(
			navigator.userAgent
		)
	) {
		hacks.noblob = true;
		hacks.nosw = true;
		console.log("quirks: using ios12 dataurl hack");
	}

	// Work around iOS trying to connect when the link is previewed.
	// You never saw this.
	if (
		/iPad|iPhone|iPod/.test(navigator.userAgent) &&
		![320, 375, 414, 768, 1_024].includes(window.innerWidth)
	) {
		hacks.noautoconnect = true;
		console.log("quirks: detected ios page preview");
	}

	// Detect for features we need for this to work.
	if (!window.WebSocket || !window.RTCPeerConnection || !window.WebAssembly) {
		hacks.browserunsupported = true;
	}

	// Firefox does not support clipboard.read.
	if (!navigator.clipboard || !navigator.clipboard.read) {
		hacks.noclipboardapi = true;
		console.log("quirks: clipboard api not supported");
	}

	// Are we in an extension?
	if (window.chrome && chrome.runtime && chrome.runtime.getURL) {
		hacks.ext = true;
		const resourceURL = chrome.runtime.getURL("");
		if (resourceURL.startsWith("moz")) {
			console.log("quirks: firefox extension, no serviceworkers");
			hacks.nosw = true;
		} else if (resourceURL.startsWith("chrome")) {
			console.log("quirks: chrome extension");
			hacks.chromeext = true;
		} else {
			console.log("quirks: unknown browser extension");
		}
	}
}

async function domready() {
	return new Promise((resolve) => {
		document.addEventListener("DOMContentLoaded", resolve);
	});
}

async function swready() {
	if (!hacks.nosw) {
		// Remove old /_/ scoped service worker.
		const regs = await navigator.serviceWorker.getRegistrations();
		for (let i = 0; i < regs.length; i++) {
			if (regs[i].scope.endsWith("/_/")) {
				regs[i].unregister();
			}
		}

		// The scope has to be "/" and not just "/_/" in order to meet Chrome's
		// PWA installability criteria.
		const reg = await navigator.serviceWorker.register("sw.js", { scope: "/" });
		serviceworker = reg.active || reg.waiting || reg.installing;

		// Add a listener for Share Target API requests forwarded from service worker.
		// This doesn't seem to actually work, and it's quite difficult to debug. We
		// might remove it soon.
		navigator.serviceWorker.addEventListener("message", (e) => {
			const msg = e.data;
			const item = new Upload(
				{
					name: msg.name,
					type: msg.type,
					size: msg.size,
				},
				msg.stream
			);
			item.li.classList.add("pending");
			item.li.innerText = `${msg.name}`;
			transfersList.appendChild(item.li);
			send(item);

			if (state === "disconnected") {
				connect();
			}
		});

		if (serviceworker) {
			console.log("service worker registered:", serviceworker.state);
		}
	}
}

async function wasmready(wasmURL: string) {
	if (!hacks.nowasm) {
		const go = new Go();
		const wasm = await WebAssembly.instantiateStreaming(
			fetch(wasmURL),
			go.importObject
		);
		go.run(wasm.instance);
	}
}

async function init() {
	// Detect Browser Quirks.
	browserhacks();

	if (hacks.ext) {
		signalserver = new URL("https://webwormhole.io/");
	}
	let wasmURL = "webwormhole.wasm";
	if (hacks.chromeext) {
		wasmURL = chrome.runtime.getURL("webwormhole.wasm");
	}

	// Wait for the ServiceWorker, WebAssembly, and DOM to be ready.
	await Promise.all([domready(), swready(), wasmready(wasmURL)]);

	// Wireup HTML.
	filepicker = document.getElementById("filepicker") as HTMLInputElement;
	dialButton = document.getElementById("dial") as HTMLInputElement;
	phraseInput = document.getElementById("magiccode") as HTMLInputElement;
	clipboardInput = document.getElementById("clipboard") as HTMLInputElement;
	mainForm = document.getElementById("main") as HTMLFormElement;
	qrImg = document.getElementById("qr") as HTMLImageElement;
	transfersList = document.getElementById("transfers") as HTMLElement;
	infoBox = document.getElementById("info") as HTMLElement;
	autocompleteBox = document.getElementById("autocomplete") as HTMLElement;

	// Friendly error message and bail out if things are clearely not going to work.
	if (hacks.browserunsupported) {
		infoBox.innerText =
			"Browser missing required feature. This application needs support for WebSockets, WebRTC, and WebAssembly.";
		document.body.classList.add("error");
		return;
	}

	// Install event handlers. If we start to allow queueing files before
	// connections we might want to move these into domready so as to not
	// block them.
	window.addEventListener("hashchange", hashchange);
	phraseInput.addEventListener("input", codechange);
	phraseInput.addEventListener("keydown", autocomplete);
	phraseInput.addEventListener("input", autocompletehint);
	filepicker.addEventListener("change", pick);
	clipboardInput.addEventListener("click", pasteClipboard);
	mainForm.addEventListener("submit", preventdefault);
	mainForm.addEventListener("submit", connect);
	qrImg.addEventListener("dblclick", copyurl);
	document.body.addEventListener("drop", preventdefault);
	document.body.addEventListener("dragenter", preventdefault);
	document.body.addEventListener("dragover", preventdefault);
	document.body.addEventListener("drop", preventdefault);
	document.body.addEventListener("dragleave", preventdefault);
	document.body.addEventListener("drop", drop);
	document.body.addEventListener("dragenter", highlight);
	document.body.addEventListener("dragover", highlight);
	document.body.addEventListener("drop", unhighlight);
	document.body.addEventListener("dragleave", unhighlight);

	if (location.hash.substring(1) !== "") {
		phraseInput.value = location.hash.substring(1);
	}
	codechange(); // User might have typed something while we were loading.
	dialButton.disabled = false;

	if (!hacks.noautoconnect && phraseInput.value !== "") {
		connect();
	}
}

init();
