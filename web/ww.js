"use strict";
/// <reference lib="es2018" />
/// <reference lib="dom" />
// Error codes from webwormhole/dial.go.
var WormholeErrorCodes;
(function (WormholeErrorCodes) {
    WormholeErrorCodes[WormholeErrorCodes["closeNoSuchSlot"] = 4000] = "closeNoSuchSlot";
    WormholeErrorCodes[WormholeErrorCodes["closeSlotTimedOut"] = 4001] = "closeSlotTimedOut";
    WormholeErrorCodes[WormholeErrorCodes["closeNoMoreSlots"] = 4002] = "closeNoMoreSlots";
    WormholeErrorCodes[WormholeErrorCodes["closeWrongProto"] = 4003] = "closeWrongProto";
    WormholeErrorCodes[WormholeErrorCodes["closePeerHungUp"] = 4004] = "closePeerHungUp";
    WormholeErrorCodes[WormholeErrorCodes["closeBadKey"] = 4005] = "closeBadKey";
    WormholeErrorCodes[WormholeErrorCodes["closeWebRTCSuccess"] = 4006] = "closeWebRTCSuccess";
    WormholeErrorCodes[WormholeErrorCodes["closeWebRTCSuccessDirect"] = 4007] = "closeWebRTCSuccessDirect";
    WormholeErrorCodes[WormholeErrorCodes["closeWebRTCSuccessRelay"] = 4008] = "closeWebRTCSuccessRelay";
    WormholeErrorCodes[WormholeErrorCodes["closeWebRTCFailed"] = 4009] = "closeWebRTCFailed";
})(WormholeErrorCodes || (WormholeErrorCodes = {}));
class Wormhole {
    constructor(signalserver, code) {
        this.signalserver = signalserver;
        this.callback = () => { };
        if (code !== "") {
            [this.slot, this.pass] = webwormhole.decode(code);
            if (this.pass.length === 0) {
                throw "bad code";
            }
            console.log("dialling slot:", this.slot);
            this.state = this.statePlayer2;
        }
        else {
            this.pass = crypto.getRandomValues(new Uint8Array(2));
            console.log("requesting slot");
            this.state = this.statePlayer1;
        }
        // There are 3 events that we need to synchronise with the caller on:
        //   1. we got the first message from the signalling server.
        //        We now have the slot number and the ICE server details, so we can
        //        create the wormhole code and PeerConnection object, and pass them back
        //        to the caller to display and configure, respectively.
        //   2. the caller is done configuring the PeerConnection.
        //        We can now create the offer or answer and send it to the peer.
        //   3. we've successfully authenticated the other peer.
        //        Signalling is now done, apart from trickling candidates. The caller
        //        can display the key fingerprint.
        this.done = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
    async statePlayer1(data) {
        const msg = JSON.parse(data);
        console.log("assigned slot:", msg.slot);
        this.slot = parseInt(msg.slot, 10);
        if (!Number.isSafeInteger(this.slot)) {
            return this.fail("invalid slot");
        }
        this.pc = this.makePeerConnection(msg.iceServers);
        this.callback(this.pc, webwormhole.encode(this.slot, this.pass));
        return this.stateWaitForPAKEA;
    }
    async statePlayer2(data) {
        if (!this.ws) {
            return this.fail("panic");
        }
        const msg = JSON.parse(data);
        this.pc = this.makePeerConnection(msg.iceServers);
        this.callback(this.pc);
        const msgA = webwormhole.start(this.pass);
        if (!msgA) {
            return this.fail("could nnt generate A's PAKE message");
        }
        console.log("message a:", msgA);
        this.ws.send(msgA);
        return this.stateWaitForPAKEB;
    }
    async stateWaitForPAKEA(data) {
        if (!this.ws || !this.pc) {
            return this.fail("panic");
        }
        console.log("got pake message a:", data);
        let msgB;
        [this.key, msgB] = webwormhole.exchange(this.pass, data);
        console.log("message b:", msgB);
        if (!this.key) {
            return this.fail("could not generate key");
        }
        if (!msgB) {
            return this.fail("could not generate B's PAKE message");
        }
        console.log("generated key");
        this.ws.send(msgB);
        this.state = this.stateWaitForLocalOffer;
        const offer = await this.pc.createOffer();
        console.log("created offer");
        this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)));
        this.pc.setLocalDescription(offer);
        return this.stateWaitForRemoteAnswer;
    }
    async stateWaitForPAKEB(data) {
        console.log("got pake message b:", data);
        this.key = webwormhole.finish(data);
        if (!this.key) {
            return this.fail("could not generate key");
        }
        console.log("generated key");
        return this.stateWaitForRemoteOffer;
    }
    async stateWaitForRemoteOffer(data) {
        if (!this.ws || !this.key || !this.pc || !this.resolve) {
            return this.fail("panic");
        }
        const msg = JSON.parse(webwormhole.open(this.key, data));
        if (!msg) {
            this.ws.send(webwormhole.seal(this.key, "bye"));
            this.ws.close(WormholeErrorCodes.closeBadKey);
            return this.fail("bad key");
        }
        if (msg.type !== "offer") {
            return this.fail("unexpected message: ${msg}");
        }
        console.log("got offer");
        this.state = this.stateWaitForLocalAnswer;
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg));
        const answer = await this.pc.createAnswer();
        console.log("created answer");
        this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)));
        this.resolve(webwormhole.fingerprint(this.key));
        this.pc.setLocalDescription(answer);
        return this.stateWaitForCandidates;
    }
    async stateWaitForRemoteAnswer(data) {
        if (!this.ws || !this.key || !this.pc || !this.resolve) {
            return this.fail("panic");
        }
        const msg = JSON.parse(webwormhole.open(this.key, data));
        if (!msg) {
            this.ws.send(webwormhole.seal(this.key, "bye"));
            this.ws.close(WormholeErrorCodes.closeBadKey);
            return this.fail("bad key");
        }
        if (msg.type !== "answer") {
            return this.fail("unexpected message: ${msg}");
        }
        console.log("got answer");
        this.pc.setRemoteDescription(new RTCSessionDescription(msg));
        this.resolve(webwormhole.fingerprint(this.key));
        return this.stateWaitForCandidates;
    }
    async stateWaitForCandidates(data) {
        if (!this.key || !this.pc) {
            return this.fail("panic");
        }
        this.processCandidate(data);
        return this.stateWaitForCandidates;
    }
    async stateWaitForLocalOffer(data) {
        return this.fail(`unexpected message: ${data}`);
    }
    async stateWaitForLocalAnswer(data) {
        // In this state we already got an offer and the WebRTC API is busy
        // making an answer. It's possible to get remote candidates from eager
        // peers now, but it's not safe to add them to this.pc on all browsers
        // just yet.
        // Delay processing the candidate until the handshake is done.
        // This "state" is special. It doesn't progress the state machine. The
        // stateWaitForRemoteOffer body moves us into and out of this state.
        await this.done;
        this.processCandidate(data);
        return this.state;
    }
    async stateError(data) {
        return this.stateError;
    }
    async close() {
        if (!this.ws || !this.pc) {
            return;
        }
        switch (this.pc.iceConnectionState) {
            case "connected": {
                const connType = await this.connType();
                // TODO UI to warn if relay is used.
                console.log("webrtc connected:", connType);
                switch (connType) {
                    case "host":
                    case "srflx":
                    case "prflx": {
                        this.ws.close(WormholeErrorCodes.closeWebRTCSuccessDirect);
                        break;
                    }
                    case "relay": {
                        this.ws.close(WormholeErrorCodes.closeWebRTCSuccessRelay);
                        break;
                    }
                    default: {
                        this.ws.close(WormholeErrorCodes.closeWebRTCSuccess);
                        break;
                    }
                }
                break;
            }
            case "failed": {
                this.ws.close(WormholeErrorCodes.closeWebRTCFailed);
                break;
            }
        }
    }
    processCandidate(data) {
        if (!this.ws || !this.key || !this.pc) {
            return;
        }
        const msg = JSON.parse(webwormhole.open(this.key, data));
        if (!msg) {
            this.fail("bad key");
            this.ws.send(webwormhole.seal(this.key, "bye"));
            this.ws.close(WormholeErrorCodes.closeBadKey);
            return;
        }
        console.log("got remote candidate", msg.candidate);
        this.pc.addIceCandidate(new RTCIceCandidate(msg));
        return;
    }
    makePeerConnection(iceServers) {
        const pc = new RTCPeerConnection({ iceServers: iceServers });
        pc.onicecandidate = (e) => {
            if (!this.ws || !this.key || !this.pc) {
                return;
            }
            if (e.candidate && e.candidate.candidate !== "") {
                console.log("got local candidate", e.candidate.candidate);
                this.ws.send(webwormhole.seal(this.key, JSON.stringify(e.candidate)));
            }
        };
        return pc;
    }
    async connType() {
        if (!this.pc) {
            return "";
        }
        // RTCStatsReport.forEach is all that's defined in the TypeScript DOM defs, which
        // makes this kind of awkward. Ah well.
        const stats = await this.pc.getStats();
        let id;
        stats.forEach((s) => {
            // s.selected gives more confidenece than s.state == "succeeded", but Chrome does
            // not implement it.
            if (s.type === "candidate-pair" &&
                s.state === "succeeded") {
                id = s.localCandidateId;
            }
        });
        if (!id) {
            return "";
        }
        let conntype = "";
        stats.forEach((s) => {
            if (s.id === id) {
                conntype = s.candidateType;
            }
        });
        return conntype;
    }
    async dial() {
        this.ws = new WebSocket(Wormhole.wsserver(this.signalserver, this.slot), Wormhole.protocol);
        // Use lambdas so that 'this' in the respective bodies refers to the Wormhole
        // instance, and not the WebSocket one.
        this.ws.onopen = () => this.onopen();
        this.ws.onerror = (e) => this.onerror(e);
        this.ws.onclose = (e) => this.onclose(e);
        this.ws.onmessage = (e) => this.onmessage(e);
        return this.done;
    }
    async onmessage(m) {
        if (!this.ws) {
            return;
        }
        // Feed the state machine a new message.
        this.state = await this.state(m.data);
    }
    onopen() {
        console.log("websocket session established");
    }
    onerror(e) {
        console.log("websocket session error:", e);
        this.fail("could not connect to signalling server");
    }
    onclose(e) {
        switch (e.code) {
            case WormholeErrorCodes.closePeerHungUp:
            case 1000:
            case 1001: {
                // Normal closure of WebSocket.
                return;
            }
            case WormholeErrorCodes.closeNoSuchSlot: {
                this.fail("no such slot");
                return;
            }
            case WormholeErrorCodes.closeSlotTimedOut: {
                this.fail("timed out");
                return;
            }
            case WormholeErrorCodes.closeNoMoreSlots: {
                this.fail("could not get slot");
                return;
            }
            case WormholeErrorCodes.closeWrongProto: {
                this.fail("wrong protocol version: must update");
                return;
            }
            default: {
                this.fail(`websocket session closed: ${e.reason} (${e.code})`);
                return;
            }
        }
    }
    fail(reason) {
        if (this.reject)
            this.reject(reason);
        return this.stateError;
    }
    // wsserver creates a WebSocket scheme (ws: or wss:) URL from an HTTP one.
    static wsserver(url, slot) {
        const u = new URL(url);
        let protocol = "wss:";
        if (u.protocol === "http:") {
            protocol = "ws:";
        }
        let path = u.pathname;
        if (!path.startsWith("/")) {
            path = `/${path}`;
        }
        if (slot) {
            path = `${path}${slot}`;
        }
        return `${protocol}//${u.host}${path}`;
    }
    // WASM loads the WebAssembly part from url.
    static async WASM(url) {
        // Polyfill for Safari WASM streaming.
        if (!WebAssembly.instantiateStreaming) {
            WebAssembly.instantiateStreaming = async (resp, importObject) => {
                const source = await (await resp).arrayBuffer();
                return await WebAssembly.instantiate(source, importObject);
            };
        }
        const go = new Go();
        const wasm = await WebAssembly.instantiateStreaming(fetch(url), go.importObject);
        go.run(wasm.instance);
    }
}
// Signalling protocol version.
Wormhole.protocol = "4";
