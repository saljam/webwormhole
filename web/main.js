"use strict";
/// <reference path="ww.ts" />
// Flags corresponding to browser and environemnt specific quirks.
const hacks = {};
// receiving is the object currently being received.
let receiving;
// sending is the object currently being sent.
let sending;
// sendqueue is the queue of objects waiting to be sent.
let sendqueue = [];
// datachannel is the active datachannel, if we're connected.
let datachannel;
// serviceworker is the helper download service worker, if enabled.
let serviceworker;
// signalserver is the address of the signalling server.
let signalserver = new URL(location.href);
// peerconnection is the active connection's WebRTC object. Global to help debugging.
let peerconnection;
// UI elements.
let filepicker;
let dialButton;
let phraseInput;
let clipboardInput;
let mainForm;
let qrImg;
let transfersList;
let infoBox;
let autocompleteBox;
function pick() {
    if (!filepicker.files) {
        return;
    }
    for (let i = 0; i < filepicker.files.length; i++) {
        sendfile(filepicker.files[i]);
    }
}
function drop(e) {
    if (!e.dataTransfer) {
        return;
    }
    const files = e.dataTransfer.files;
    const t = e.dataTransfer.getData("text");
    if (files.length !== 0) {
        for (let i = 0; i < files.length; i++) {
            sendfile(files[i]);
        }
    }
    else if (t.length !== 0) {
        sendtext(t);
    }
    // A shortcut to save users a click. If we're disconnected and they drag
    // a file in treat it as a click on the new/join wormhole button.
    // TODO use global connection state.
    if (!dialButton.disabled) {
        connect();
    }
}
// Handle a paste event from cmd-v/ctl-v.
function pasteEvent(e) {
    if (!e.clipboardData) {
        return;
    }
    const files = e.clipboardData.files;
    const t = e.clipboardData.getData("text");
    if (files.length !== 0) {
        for (let i = 0; i < files.length; i++) {
            sendfile(files[i]);
        }
    }
    else if (t.length !== 0) {
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
        }
        else if (items[i].types.includes("text/plain")) {
            const blob = await items[i].getType("text/plain");
            sendtext(await blob.text());
        }
    }
}
class DataChannelWriter {
    constructor(dc) {
        this.chunksize = 32 << 10;
        this.bufferedAmountHighThreshold = 1 << 20;
        this.bufferedAmountLowThreshold = 1 << 20;
        this.dc = dc;
        this.dc.bufferedAmountLowThreshold = this.bufferedAmountLowThreshold;
        this.dc.onbufferedamountlow = () => {
            if (this.resolve)
                this.resolve();
        };
        this.ready = new Promise((resolve) => {
            this.resolve = resolve; // TODO needed?
            this.resolve();
        });
    }
    async write(buf) {
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
async function sendtext(m) {
    const item = {
        f: {
            name: m,
            type: "application/webwormhole-text",
            size: 0,
        },
        offset: 0,
        li: document.createElement("li"),
        progress: document.createElement("progress"),
    };
    item.li.classList.add("pending");
    item.li.appendChild(document
        .createElement("pre")
        .appendChild(document.createTextNode(`${item.f.name}`)));
    transfersList.appendChild(item.li);
    sendqueue.push(item);
    send();
}
async function sendfile(f) {
    const item = {
        f,
        offset: 0,
        li: document.createElement("li"),
        progress: document.createElement("progress"),
    };
    item.offset = 0;
    item.li = document.createElement("li");
    item.li.innerText = `${f.name}`;
    item.li.classList.add("pending");
    transfersList.appendChild(item.li);
    sendqueue.push(item);
    send();
}
async function send() {
    if (!datachannel) {
        console.log("not connected yet");
        return;
    }
    if (sending) {
        console.log("haven't finished sending", sending.f.name);
        return;
    }
    if (sendqueue.length < 1) {
        console.log("send queue is empty");
        return;
    }
    sending = sendqueue.shift();
    // type assersion
    if (!sending) {
        return;
    }
    console.log("sending", sending.f.name, sending.f.type);
    sending.li.classList.remove("pending");
    sending.li.classList.add("upload");
    sending.li.appendChild(document.createElement("progress"));
    sending.progress = sending.li.getElementsByTagName("progress")[0];
    datachannel.send(new TextEncoder().encode(JSON.stringify({
        name: sending.f.name,
        size: sending.f.size,
        type: sending.f.type,
    })));
    if (sending.f.type === "application/webwormhole-text") {
        sending.li.removeChild(sending.progress);
        sending = undefined;
        send(); // TODO avoid tail call. loop over queue from an outer function.
        return;
    }
    const writer = new DataChannelWriter(datachannel);
    if (sending.f.stream) {
        const reader = sending.f.stream().getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            await writer.write(value);
            sending.offset += value.length;
            sending.progress.value = sending.offset / sending.f.size;
        }
    }
    else if (sending.f.slice) {
        // Backwards compatability with browsers that don't have sending.f.stream.
        // TODO which ones are these? can we delete this yet?
        function read(b) {
            return new Promise((resolve) => {
                const fr = new FileReader();
                fr.onload = () => {
                    resolve(new Uint8Array(fr.result));
                };
                fr.readAsArrayBuffer(b);
            });
        }
        const chunksize = 64 << 10;
        while (sending.offset < sending.f.size) {
            let end = sending.offset + chunksize;
            if (end > sending.f.size) {
                end = sending.f.size;
            }
            await writer.write(await read(sending.f.slice(sending.offset, end)));
            sending.offset = end;
            sending.progress.value = sending.offset / sending.f.size;
        }
    }
    else {
        // type assersion
        console.log("panic: cannot get data out of file");
    }
    sending.li.removeChild(sending.progress);
    sending = undefined;
    send(); // TODO avoid tail call. loop over queue from an outer function.
    return;
}
function triggerDownload() {
    if (!receiving) {
        return;
    } // type assertion
    if (serviceworker) {
        // `<a download=...>` doesn't work with service workers on Chrome yet.
        // See https://bugs.chromium.org/p/chromium/issues/detail?id=468227
        //
        // Possible solutions:
        //
        // - `window.open` is blocked as a popup.
        // window.open(`${SW_PREFIX}/${receiving.id}`);
        //
        // - And this is quite scary but `Content-Disposition` to the rescue!
        //   It will navigate to 404 page if there is no service worker for some reason...
        //   But if `postMessage` didn't throw we should be safe.
        window.location.assign(`/_/${receiving.id}`);
        return;
    }
    if (!receiving.data) {
        return;
    } // type assertion
    if (hacks.noblob) {
        const blob = new Blob([receiving.data], { type: receiving.type });
        const fr = new FileReader();
        fr.onloadend = () => {
            if (!receiving || !receiving.data) {
                return;
            } // type assertion
            receiving.a.href = fr.result;
            receiving.a.download = receiving.name;
        };
        fr.readAsDataURL(blob);
        return;
    }
    const blob = new Blob([receiving.data], { type: receiving.type });
    receiving.a.href = URL.createObjectURL(blob);
    receiving.a.download = receiving.name;
    receiving.a.click();
}
function receive(e) {
    if (!receiving) {
        const header = JSON.parse(new TextDecoder("utf8").decode(e.data));
        receiving = {
            name: header.name,
            type: header.type,
            size: header.size,
            offset: 0,
            id: `${Math.random().toString(16).substring(2)}-${encodeURIComponent(header.name)}`,
            li: document.createElement("li"),
            a: document.createElement("a"),
            progress: document.createElement("progress"),
        };
        receiving.li.classList.add("download");
        // Special case raw text that's been received.
        if (receiving.type === "application/webwormhole-text") {
            receiving.li.appendChild(document
                .createElement("pre")
                .appendChild(document.createTextNode(`${receiving.name}`)));
            transfersList.appendChild(receiving.li);
            receiving = undefined;
            return;
        }
        receiving.a.appendChild(document.createTextNode(`${receiving.name}`));
        receiving.li.appendChild(receiving.a);
        receiving.li.appendChild(receiving.progress);
        transfersList.appendChild(receiving.li);
        if (serviceworker) {
            serviceworker.postMessage({
                id: receiving.id,
                type: "metadata",
                name: receiving.name,
                size: receiving.size,
                filetype: receiving.type,
            });
            triggerDownload();
        }
        else {
            receiving.data = new Uint8Array(receiving.size);
        }
        return;
    }
    const chunkSize = e.data.byteLength;
    if (receiving.offset + chunkSize > receiving.size) {
        const error = "received more bytes than expected";
        if (serviceworker) {
            serviceworker.postMessage({ id: receiving.id, type: "error", error });
        }
        throw error;
    }
    if (serviceworker) {
        serviceworker.postMessage({
            id: receiving.id,
            type: "data",
            data: e.data,
            offset: receiving.offset,
        }, [e.data]);
    }
    else {
        if (!receiving.data) {
            return;
        } // panic
        receiving.data.set(new Uint8Array(e.data), receiving.offset);
    }
    receiving.offset += chunkSize;
    receiving.progress.value = receiving.offset / receiving.size;
    if (receiving.offset === receiving.size) {
        if (serviceworker) {
            serviceworker.postMessage({ id: receiving.id, type: "end" });
        }
        else {
            triggerDownload();
        }
        if (receiving.li && receiving.progress) {
            // type assertion
            receiving.li.removeChild(receiving.progress);
        }
        receiving = undefined;
    }
}
async function connect() {
    try {
        dialling();
        const w = new Wormhole(signalserver.href, phraseInput.value);
        w.callback = (pc, code) => {
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
                        console.log("webrtc connection failed connectionState:", pc.connectionState, "iceConnectionState", pc.iceConnectionState);
                        w.close();
                        break;
                    }
                }
            };
            const dc = pc.createDataChannel("data", { negotiated: true, id: 0 });
            dc.onopen = () => {
                connected();
                datachannel = dc;
                // Send anything we have in the send queue.
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
        document.body.style.backgroundColor = `var(--palette-${fingerprint[0] % 8})`;
    }
    catch (err) {
        disconnected(err);
    }
}
function waiting() {
    infoBox.innerText =
        "Waiting for the other side to join by typing the wormhole phrase, opening this URL, or scanning the QR code.";
}
function dialling() {
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
    infoBox.innerText = "";
    document.body.classList.remove("dialling");
    document.body.classList.add("connected");
    document.body.classList.remove("disconnected");
    location.hash = "";
}
function disconnected(reason) {
    datachannel = null;
    sendqueue = [];
    document.body.style.backgroundColor = "";
    // TODO better error types or at least hoist the strings to consts.
    if (reason === "bad key") {
        infoBox.innerText = "Wrong wormhole phrase.";
    }
    else if (reason === "bad code") {
        infoBox.innerText = "Not a valid wormhole phrase.";
    }
    else if (reason === "no such slot") {
        infoBox.innerText = "No such slot. The wormhole might have expired.";
    }
    else if (reason === "timed out") {
        infoBox.innerText = "Wormhole expired.";
    }
    else if (reason === "could not connect to signalling server") {
        infoBox.innerText =
            "Could not reach the signalling server. Refresh page and try again.";
    }
    else if (reason === "webrtc connection closed") {
        infoBox.innerText = "Disconnected.";
    }
    else if (reason === "webrtc connection failed") {
        infoBox.innerText = "Network error.";
    }
    else if (reason === "datachannel closed") {
        infoBox.innerText = "Disconnected.";
    }
    else if (reason === "webrtc connection failed") {
        infoBox.innerText = "Network error.";
    }
    else {
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
    if (serviceworker && receiving) {
        serviceworker.postMessage({
            id: receiving.id,
            type: "error",
            error: "rtc disconnected",
        });
        receiving = undefined;
        // TODO better cancellation of receiving?
    }
}
function highlight() {
    document.body.classList.add("highlight");
}
function unhighlight() {
    document.body.classList.remove("highlight");
}
function preventdefault(e) {
    e.preventDefault();
    e.stopPropagation();
}
async function copyurl() {
    await navigator.clipboard.writeText(signalserver.href);
    // TODO toast message on success.
}
function updateqr(url) {
    const qr = webwormhole.qrencode(url);
    if (url === "" || qr === null) {
        qrImg.src = "";
        qrImg.alt = "";
        qrImg.title = "";
        return;
    }
    qrImg.src = URL.createObjectURL(new Blob([qr]));
    qrImg.alt = url;
    qrImg.title = `${url} - double click to copy`;
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
    }
    else {
        dialButton.value = "JOIN WORMHOLE";
    }
}
function autocompletehint() {
    const words = phraseInput.value.split("-");
    const prefix = words[words.length - 1];
    const hint = webwormhole.match(prefix);
    autocompleteBox.innerText = hint;
}
function autocomplete(e) {
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
        console.log("websocket:", !!window.WebSocket, "webrtc:", !!window.RTCPeerConnection, "wasm:", !!window.WebAssembly);
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
    if (/Safari/.test(navigator.userAgent) &&
        !(/Chrome/.test(navigator.userAgent) || /Chromium/.test(navigator.userAgent))) {
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
    if (/^Mozilla\/5.0 \(iPhone; CPU iPhone OS 12_[0-9]_[0-9] like Mac OS X\)/.test(navigator.userAgent)) {
        hacks.noblob = true;
        hacks.nosw = true;
        console.log("quirks: using ios12 dataurl hack");
    }
    // Work around iOS trying to connect when the link is previewed.
    // You never saw this.
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) &&
        ![320, 375, 414, 768, 1024].includes(window.innerWidth)) {
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
        }
        else if (resourceURL.startsWith("chrome")) {
            console.log("quirks: chrome extension");
            hacks.chromeext = true;
        }
        else {
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
        // Add a stub listener for Share Target API requests forwarded from service worker.
        navigator.serviceWorker.addEventListener("message", (e) => {
            console.log("got shared message:", e.data);
            // TODO start a new connection (only if we're not connected already)
            // and queue the shared file.
        });
        if (serviceworker) {
            console.log("service worker registered:", serviceworker.state);
        }
    }
}
async function wasmready(wasmURL) {
    if (!hacks.nowasm) {
        const go = new Go();
        const wasm = await WebAssembly.instantiateStreaming(fetch(wasmURL), go.importObject);
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
    filepicker = document.getElementById("filepicker");
    dialButton = document.getElementById("dial");
    phraseInput = document.getElementById("magiccode");
    clipboardInput = document.getElementById("clipboard");
    mainForm = document.getElementById("main");
    qrImg = document.getElementById("qr");
    transfersList = document.getElementById("transfers");
    infoBox = document.getElementById("info");
    autocompleteBox = document.getElementById("autocomplete");
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
