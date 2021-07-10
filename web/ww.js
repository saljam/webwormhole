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
        if (code !== "") {
            [this.slot, this.pass] = webwormhole.decode(code);
            if (this.pass.length === 0) {
                throw "bad code";
            }
            console.log("dialling slot:", this.slot);
            this.state = "b";
        }
        else {
            this.pass = crypto.getRandomValues(new Uint8Array(2));
            console.log("requesting slot");
            this.state = "a";
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
    async connType() {
        if (!this.pc) {
            return "";
        }
        // RTCStatsReport.forEach is all that's defined in the TypeScript DOM defs, which
        // makes this kind of awkward. Ah well.
        const stats = await this.pc.getStats();
        let id;
        stats.forEach(s => {
            // s.selected gives more confidenece than s.state == "succeeded", but Chrome does
            // not implement it.
            if (s.type === "candidate-pair" && s.state === "succeeded") {
                id = s.localCandidateId;
            }
        });
        if (!id) {
            return "";
        }
        let conntype = "";
        stats.forEach(s => {
            console.log(s);
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
        // This all being so asynchronous makes it so the only way apparent to
        // me to describe the PAKE and WebRTC message exchange state machine
        // a big case statement. I'd welcome a clearer or more idiomatic approach
        // in JS if someone were to suggest one.
        switch (this.state) {
            case "a": {
                const msg = JSON.parse(m.data);
                console.log("assigned slot:", msg.slot);
                this.slot = parseInt(msg.slot, 10);
                if (!Number.isSafeInteger(this.slot)) {
                    this.fail("invalid slot");
                    return;
                }
                this.makePeerConnection(msg.iceServers);
                if (this.callback && this.pc) {
                    this.callback(this.pc, webwormhole.encode(this.slot, this.pass));
                }
                this.state = "wait_for_pake_a";
                return;
            }
            case "b": {
                const msg = JSON.parse(m.data);
                this.makePeerConnection(msg.iceServers);
                if (this.callback && this.pc) {
                    this.callback(this.pc);
                }
                const msgA = webwormhole.start(this.pass);
                if (!msgA) {
                    this.fail("couldn't generate A's PAKE message");
                    return;
                }
                console.log("message a:", msgA);
                this.ws.send(msgA);
                this.state = "wait_for_pake_b";
                return;
            }
            case "wait_for_pake_a": {
                if (!this.pc) {
                    return;
                }
                console.log("got pake message a:", m.data);
                let msgB;
                [this.key, msgB] = webwormhole.exchange(this.pass, m.data);
                console.log("message b:", msgB);
                if (!this.key) {
                    this.fail("could not generate key");
                    return;
                }
                if (!msgB) {
                    this.fail("couldn't generate B's PAKE message");
                    return;
                }
                console.log("generated key");
                this.ws.send(msgB);
                this.state = "wait_for_local_offer";
                const offer = await this.pc.createOffer();
                console.log("created offer");
                this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)));
                this.state = "wait_for_webtc_answer";
                this.pc.setLocalDescription(offer);
                return;
            }
            case "wait_for_pake_b": {
                console.log("got pake message b:", m.data);
                this.key = webwormhole.finish(m.data);
                if (!this.key) {
                    this.fail("could not generate key");
                    return;
                }
                console.log("generated key");
                this.state = "wait_for_webtc_offer";
                return;
            }
            case "wait_for_webtc_offer": {
                if (!this.key || !this.pc || !this.resolve) {
                    return;
                }
                const msg = JSON.parse(webwormhole.open(this.key, m.data));
                if (!msg) {
                    this.fail("bad key");
                    this.ws.send(webwormhole.seal(this.key, "bye"));
                    this.ws.close(WormholeErrorCodes.closeBadKey);
                    return;
                }
                if (msg.type !== "offer") {
                    console.log("unexpected message", msg);
                    this.fail("unexpected message");
                    return;
                }
                console.log("got offer");
                this.state = "wait_for_local_answer";
                await this.pc.setRemoteDescription(new RTCSessionDescription(msg));
                const answer = await this.pc.createAnswer();
                console.log("created answer");
                this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)));
                this.resolve(webwormhole.fingerprint(this.key));
                this.pc.setLocalDescription(answer);
                this.state = "wait_for_candidates";
                return;
            }
            case "wait_for_webtc_answer": {
                if (!this.key || !this.pc || !this.resolve) {
                    return;
                }
                const msg = JSON.parse(webwormhole.open(this.key, m.data));
                if (!msg) {
                    this.fail("bad key");
                    this.ws.send(webwormhole.seal(this.key, "bye"));
                    this.ws.close(WormholeErrorCodes.closeBadKey);
                    return;
                }
                if (msg.type !== "answer") {
                    console.log("unexpected message", msg);
                    this.fail("unexpected message");
                    return;
                }
                console.log("got answer");
                this.pc.setRemoteDescription(new RTCSessionDescription(msg));
                this.resolve(webwormhole.fingerprint(this.key));
                this.state = "wait_for_candidates";
                return;
            }
            case "wait_for_candidates": {
                if (!this.key || !this.pc) {
                    return;
                }
                this.processCandidate(m.data);
                return;
            }
            case "wait_for_local_offer": {
                this.fail(`unexpected message: ${m.data}`);
                return;
            }
            case "wait_for_local_answer": {
                // In this state we already got an offer and the WebRTC API is busy
                // making an answer. It's possible to get remote candidates from eager
                // peers now, but it's not safe to add them to this.pc on all browsers
                // just yet.
                // Delay processing the candidate until the handshake is done.
                // This "state" is special. It doesn't progress the state machine. The
                // wait_for_webtc_offer state moves us into and out of this state. (My
                // brain is just not wired for async/await...)
                await this.done;
                this.processCandidate(m.data);
                return;
            }
            case "error": return;
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
        let normalisedICEServers = [];
        for (let i = 0; i < iceServers.length; i++) {
            normalisedICEServers.push({
                urls: iceServers[i].URLs,
                username: iceServers[i].Username,
                credential: iceServers[i].Credential,
            });
        }
        this.pc = new RTCPeerConnection({
            iceServers: normalisedICEServers,
        });
        this.pc.onicecandidate = (e) => {
            if (!this.ws || !this.key || !this.pc) {
                return;
            }
            if (e.candidate && e.candidate.candidate !== "") {
                console.log("got local candidate", e.candidate.candidate);
                this.ws.send(webwormhole.seal(this.key, JSON.stringify(e.candidate)));
            }
        };
    }
    onopen() {
        console.log("websocket session established");
    }
    onerror(e) {
        console.log("websocket session error:", e);
        this.fail("could not connect to signalling server");
    }
    onclose(e) {
        if (e.code === 4000) {
            this.fail("no such slot");
        }
        else if (e.code === 4001) {
            this.fail("timed out");
        }
        else if (e.code === 4002) {
            this.fail("could not get slot");
        }
        else if (e.code === 4003) {
            this.fail("wrong protocol version, must update");
        }
        else if (e.code === 4004 || e.code === 1001) {
            // Workaround for regression introduced in firefox around version ~78.
            // Usually the websocket connection stays open for the duration of the session, since
            // it doesn't hurt and it make candidate trickling easier. We only do this here out of
            // laziness. The go code has more disciplined websocket lifecycle management.
            // Recent versions of Firefox introduced a bug where websocket connections are killed
            // when a download begins. This would happen after the WebRTC connection is set up
            // so it's not really an error we need to react to.
        }
        else {
            this.fail(`websocket session closed: ${e.reason} (${e.code})`);
        }
    }
    fail(reason) {
        if (this.reject)
            this.reject(reason);
        this.state = "error";
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
