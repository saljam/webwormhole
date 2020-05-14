import { encode, decode } from './wordlist.js'

const wsserver = (url, slot) => {
  const u = new URL(url)
  let protocol = 'wss:'
  if (u.protocol === 'http:') {
    protocol = 'ws:'
  }
  let path = u.pathname + 's/' + slot
  if (!path.startsWith("/")) {
    path = "/" + path
  }
  return protocol + "//" + u.host + path
}

// newwormhole creates wormhole, the A side.
export const newwormhole = async (signal, pc) => {
  const ws = new WebSocket(wsserver(signal, ""))
  let key, slot, pass
  let slotC, connC
  const slotP = new Promise((resolve, reject) => {
    slotC = { resolve, reject }
  })
  const connP = new Promise((resolve, reject) => {
    connC = { resolve, reject }
  })
  ws.onmessage = async m => {
    if (!slot) {
      slot = m.data
      pass = crypto.getRandomValues(new Uint8Array(2))
      console.log('assigned slot:', slot)
      slotC.resolve(slot + '-' + encode(pass))
      return
    }
    if (!key) {
      console.log('got pake message a:', m.data)
      let msgB;
      [key, msgB] = util.exchange(pass, m.data)
      console.log('message b:', msgB)
      if (key == null) {
        connC.reject("couldn't generate key")
      }
      console.log('generated key')
      ws.send(msgB)
      pc.onicecandidate = e => {
        if (e.candidate && e.candidate.candidate !== '') {
          console.log('got local candidate')
          ws.send(util.seal(key, JSON.stringify(e.candidate)))
        } else if (!e.candidate) {
          logNAT(pc.localDescription.sdp)
        }
      }
      await pc.setLocalDescription(await pc.createOffer())
      console.log('created offer')
      ws.send(util.seal(key, JSON.stringify(pc.localDescription)))
      return
    }
    const jsonmsg = util.open(key, m.data)
    if (jsonmsg === null) {
      // Auth failed. Send something so B knows.
      ws.send(util.seal(key, 'bye'))
      ws.close()
      connC.reject('bad key')
      return
    }
    const msg = JSON.parse(jsonmsg)
    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg))
      console.log('got answer')
      return
    }
    if (msg.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(msg))
      console.log('got remote candidate')
      return
    }
    console.log('unknown message type', msg)
  }
  ws.onopen = e => {
    console.log('websocket session established')
  }
  ws.onerror = e => {
    connC.reject("couldn't connect to signalling server")
    console.log('websocket session error', e)
  }
  ws.onclose = e => {
    // TODO hardcoded codes here for now. At somepoint, dialling code should
    // be in the wasm portion and reuse server symbols.
    if (e.code === 4000) {
      connC.reject('no such slot')
    } else if (e.code === 4001) {
      connC.reject('timed out')
    } else if (e.code === 4002) {
      connC.reject("couldn't get slot")
    } else {
      console.log('websocket session closed', e.reason ? e.reason : '')
    }
  }

  return [await slotP, connP]
}

// dial joins a wormhole, the B side.
export const dial = async (signal, pc, code) => {
  const [slot, ...passparts] = code.split('-')
  const pass = decode(passparts)

  console.log('dialling slot:', slot)

  const ws = new WebSocket(wsserver(signal, slot))
  let key
  let connC
  const connP = new Promise((resolve, reject) => {
    connC = { resolve, reject }
  })
  ws.onmessage = async m => {
    if (!key) {
      console.log('got pake message b:', m.data)
      key = util.finish(m.data)
      if (key == null) {
        connC.reject("couldn't generate key")
      }
      console.log('generated key')
      pc.onicecandidate = e => {
        if (e.candidate && e.candidate.candidate !== '') {
          console.log('got local candidate')
          ws.send(util.seal(key, JSON.stringify(e.candidate)))
        } else if (!e.candidate) {
          logNAT(pc.localDescription.sdp)
        }
      }
      return
    }
    const jmsg = util.open(key, m.data)
    if (jmsg == null) {
      // Auth failed. Send something so A knows.
      ws.send(util.seal(key, 'bye'))
      ws.close()
      connC.reject('bad key')
      return
    }
    const msg = JSON.parse(jmsg)
    if (msg.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg))
      console.log('got offer')
      await pc.setLocalDescription(await pc.createAnswer())
      console.log('created answer')
      ws.send(util.seal(key, JSON.stringify(pc.localDescription)))
      return
    }
    if (msg.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(msg))
      console.log('got remote candidate')
      return
    }
    console.log('unknown message type', msg)
  }
  ws.onopen = async e => {
    console.log('websocket opened')
    const msgA = util.start(pass)
    if (msgA == null) {
      connC.reject("couldn't generate A's PAKE message")
    }
    console.log('message a:', msgA)
    ws.send(msgA)
  }
  ws.onerror = e => {
    connC.reject("couldn't connect to signalling server")
    console.log('websocket session error', e)
  }
  ws.onclose = e => {
    // TODO hardcoded codes here for now. At somepoint, dialling code should
    // be in the wasm portion and reuse server symbols.
    if (e.code === 4000) {
      connC.reject('no such slot')
    } else if (e.code === 4001) {
      connC.reject('timed out')
    } else if (e.code === 4002) {
      connC.reject("couldn't get slot")
    } else {
      console.log('websocket session closed', e.reason ? e.reason : '')
    }
  }
  return connP
}

// logNAT tries to guess the type of NAT based on candidates and log it.
const logNAT = sdp => {
  let count = 0; let host = 0; let srflx = 0
  const portmap = new Map()

  const lines = sdp.replace(/\r/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('a=candidate:')) {
      continue
    }
    const parts = lines[i].substring('a=candidate:'.length).split(' ')
    const proto = parts[2].toLowerCase()
    const port = parts[5]
    const typ = parts[7]
    if (proto !== 'udp') {
      continue
    }
    count++
    if (typ === 'host') {
      host++
    } else if (typ === 'srflx') {
      srflx++
      let rport = ''
      for (let j = 8; j < parts.length; j += 2) {
        if (parts[j] === 'rport') {
          rport = parts[j + 1]
        }
      }
      if (!portmap.get(rport)) {
        portmap.set(rport, new Set())
      }
      portmap.get(rport).add(port)
    }
  }
  console.log(`local udp candidates: ${count} (host: ${host} stun: ${srflx})`)
  let maxmapping = 0
  portmap.forEach(v => {
    if (v.size > maxmapping) {
      maxmapping = v.size
    }
  })
  if (maxmapping === 0) {
    console.log('nat: unknown: ice disabled or stun blocked')
  } else if (maxmapping === 1) {
    console.log('nat: cone or none: 1:1 port mapping')
  } else if (maxmapping > 1) {
    console.log('nat: symmetric: 1:n port mapping (bad news)')
  } else {
    console.log('nat: failed to estimate nat type')
  }
  console.log('for more webrtc troubleshooting try https://test.webrtc.org/ and your browser webrtc logs (about:webrtc or chrome://webrtc-internals/)')
}
