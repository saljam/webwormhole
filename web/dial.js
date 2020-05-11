import { genpassword } from './wordlist.js'

const signalserver = ((location.protocol === 'https:') ? 'wss://' : 'ws://') + location.host + '/s/'

// newwormhole creates wormhole, the A side.
export const newwormhole = async (pc) => {
  const ws = new WebSocket(signalserver)
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
      pass = genpassword(2)
      console.log('assigned slot:', slot)
      slotC.resolve(slot + '-' + pass)
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
        if (e.candidate && e.candidate.candidate !== "") {
          console.log('got local candidate:', e.candidate.candidate)
          ws.send(util.seal(key, JSON.stringify(e.candidate)))
        }
        candidateStatsAdd(e.candidate)
      }
      await pc.setLocalDescription(await pc.createOffer())
      console.log('created offer:', pc.localDescription.sdp)
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
      console.log('got answer:', pc.remoteDescription.sdp)
      return
    }
    if (msg.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(msg))
      console.log('got remote candidate:', msg.candidate)
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
      console.log('websocket session closed', e.reason)
    }
  }

  return [await slotP, connP]
}

// dial joins a wormhole, the B side.
export const dial = async (pc, code) => {
  const [slot, ...passparts] = code.split('-')
  const pass = passparts.join('-')

  console.log('dialling slot:', slot)

  const ws = new WebSocket(signalserver + slot)
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
        if (e.candidate && e.candidate.candidate !== "") {
          console.log('got local candidate:', e.candidate.candidate)
          ws.send(util.seal(key, JSON.stringify(e.candidate)))
        }
        candidateStatsAdd(e.candidate)
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
      console.log('got offer:', pc.remoteDescription.sdp)
      await pc.setLocalDescription(await pc.createAnswer())
      console.log('created answer:', pc.localDescription.sdp)
      ws.send(util.seal(key, JSON.stringify(pc.localDescription)))
      return
    }
    if (msg.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(msg))
      console.log('got remote candidate:', msg.candidate)
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
      console.log('websocket session closed', e.reason)
    }
  }
  return connP
}

// candidateStats tries to collect statistics about candidates to help
// diagnose NAT issues.
let candidateStats = []
const candidateStatsAdd = candidate => {
  if (candidate) {
    if (candidate.candidate !== "") {
      candidateStats.push(parseCandidate(candidate.candidate))
    }
    return
  }
  // We're done collecting candidates. Log a summary.
  let udp = candidateStats.filter(c => c.protocol === 'udp')
  let srflx = candidateStats.filter(c => c.type === 'srflx')
  
  console.log(`CANDIDATES SUMMARY`)
  console.log(`total: ${candidateStats.length}`)
  console.log(`udp: ${udp.length}`)
  console.log(`stun: ${srflx.length}`)
  if (srflx.length === 0) {
    console.log(`nat: unknown: ice disabled or stun blocked`)
  } else if (srflx.length === 1) {
    console.log(`nat: cone or none`)
  } else if (srflx.length === 2) {
    if (srflx[0].relatedPort === srflx[1].relatedPort &&
        srflx[0].port !== srflx[1].port) {
      console.log(`nat: symmetric (bad news)`)
    } else if (srflx[0].relatedPort === srflx[1].relatedPort &&
        srflx[0].port === srflx[1].port) {
      console.log(`nat: cone or none`)
    } else {
      console.log(`nat: unknown: stun results for different internal source ports`)
    }
  } else {
    console.log(`nat: unknown: more stun results than expected`)
  }
  console.log(`------------------`)
  candidateStats = []
}

// parseCandidate based on https://github.com/fippo/sdp
const parseCandidate = line => {
  var parts;
  // Parse both variants.
  if (line.indexOf('a=candidate:') === 0) {
    parts = line.substring(12).split(' ');
  } else {
    parts = line.substring(10).split(' ');
  }

  var candidate = {
    foundation: parts[0],
    component: parts[1],
    protocol: parts[2].toLowerCase(),
    priority: parseInt(parts[3], 10),
    ip: parts[4],
    port: parseInt(parts[5], 10),
    // skip parts[6] == 'typ'
    type: parts[7]
  };

  for (var i = 8; i < parts.length; i += 2) {
    switch (parts[i]) {
      case 'raddr':
        candidate.relatedAddress = parts[i + 1];
        break;
      case 'rport':
        candidate.relatedPort = parseInt(parts[i + 1], 10);
        break;
      case 'tcptype':
        candidate.tcpType = parts[i + 1];
        break;
      default: // Unknown extensions are silently ignored.
        break;
    }
  }
  return candidate;
}