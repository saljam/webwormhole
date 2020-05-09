import { goready, newwormhole, dial } from './dial.js'

const SW_PREFIX = '/_'

// TODO multiple streams.
let receiving
let sending
let datachannel
let downloadServiceWorker // Service worker managing download urls.

const serviceWorkerInUse = !hacks.noblob && !window.safari && !!(navigator.serviceWorker)

if (serviceWorkerInUse) {
  navigator.serviceWorker.register('sw.js', {
    scope: `${SW_PREFIX}/`
  }).then(function (registration) {
    // TODO handle updates to service workers.
    console.log("service worker registered")
    downloadServiceWorker = registration.active || registration.waiting || registration.installing
  })
}

const pick = e => {
  const files = document.getElementById('filepicker').files
  for (let i = 0; i < files.length; i++) {
    send(files[i])
  }
}

const drop = e => {
  const files = e.dataTransfer.files
  for (let i = 0; i < files.length; i++) {
    send(files[i])
  }
}

class DataChannelWriter {
  constructor (dc) {
    this.dc = dc
    this.chunksize = 32 << 10
    this.bufferedAmountHighThreshold = 1 << 20
    this.dc.bufferedAmountLowThreshold = 512 << 10
    this.dc.onbufferedamountlow = () => {
      this.resolve()
    }
    this.ready = new Promise((resolve) => {
      this.resolve = resolve
      this.resolve()
    })
  }

  async write (buf) {
    for (let offset = 0; offset < buf.length; offset += this.chunksize) {
      let end = offset + this.chunksize
      if (end > buf.length) {
        end = buf.length
      }
      await this.ready
      this.dc.send(buf.subarray(offset, end))
    }
    if (this.dc.bufferedAmount >= this.bufferedAmountHighThreshold) {
      this.ready = new Promise(resolve => { this.resolve = resolve })
    }
  }
}

const send = async f => {
  if (sending) {
    console.log("haven't finished sending", sending.name)
    return
  }

  console.log('sending', f.name)
  datachannel.send(new TextEncoder('utf8').encode(JSON.stringify({
    name: f.name,
    size: f.size,
    type: f.type
  })))

  sending = { f }
  sending.offset = 0
  sending.li = document.createElement('li')
  sending.li.appendChild(document.createTextNode(`↑ ${f.name}`))
  sending.li.appendChild(document.createElement('progress'))
  sending.progress = sending.li.getElementsByTagName('progress')[0]
  document.getElementById('transfers').appendChild(sending.li)

  const writer = new DataChannelWriter(datachannel)
  if (!f.stream) {
    // Hack around Safari's lack of Blob.stream() and arrayBuffer().
    // This is unbenchmarked and could probably be made better.
    const read = b => {
      return new Promise(resolve => {
        const fr = new FileReader()
        fr.onload = (e) => {
          resolve(new Uint8Array(e.target.result))
        }
        fr.readAsArrayBuffer(b)
      })
    }
    const chunksize = 64 << 10
    while (sending.offset < f.size) {
      let end = sending.offset + chunksize
      if (end > f.size) {
        end = f.size
      }
      await writer.write(await read(f.slice(sending.offset, end)))
      sending.offset = end
      sending.progress.value = sending.offset / f.size
    }
  } else {
    const reader = f.stream().getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      await writer.write(value)
      sending.offset += value.length
      sending.progress.value = sending.offset / f.size
    }
  }
  sending.li.removeChild(sending.progress)
  sending = null
}

const triggerDownload = receiving => {
  if (serviceWorkerInUse) {
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
    window.location = `${SW_PREFIX}/${receiving.id}`
  } else if (hacks.noblob) {
    const blob = new Blob([receiving.data], {type: receiving.type})
    let reader = new FileReader()
    reader.onloadend = () => {
      receiving.a.href = reader.result
      receiving.a.download = receiving.name
    }
    reader.readAsDataURL(blob)
  } else {
    const blob = new Blob([receiving.data], {type: receiving.type})
    receiving.a.href = URL.createObjectURL(blob)
    receiving.a.download = receiving.name
    receiving.a.click()
  }
}

// receive is the new message handler.
//
// This function cannot be async without carefully thinking through the
// order of messages coming in.
const receive = e => {
  if (!receiving) {
    receiving = JSON.parse(new TextDecoder('utf8').decode(e.data))
    receiving.id = Math.random().toString(16).substring(2) + '-' + encodeURIComponent(receiving.name)
    receiving.offset = 0
    if (!serviceWorkerInUse) { receiving.data = new Uint8Array(receiving.size) }

    receiving.li = document.createElement('li')
    receiving.li.appendChild(document.createElement('a'))
    receiving.a = receiving.li.getElementsByTagName('a')[0]
    receiving.a.appendChild(document.createTextNode(`↓ ${receiving.name}`))
    receiving.li.appendChild(document.createElement('progress'))
    receiving.progress = receiving.li.getElementsByTagName('progress')[0]
    document.getElementById('transfers').appendChild(receiving.li)

    if (serviceWorkerInUse) {
      downloadServiceWorker.postMessage({
        id: receiving.id,
        type: 'metadata',
        name: receiving.name,
        size: receiving.size,
        filetype: receiving.type
      })
      triggerDownload(receiving)
    }

    return
  }

  const chunkSize = e.data.byteLength

  if (receiving.offset + chunkSize > receiving.size) {
    const error = 'received more bytes than expected'
    if (serviceWorkerInUse) { downloadServiceWorker.postMessage({ id: receiving.id, type: 'error', error }) }
    throw error
  }

  if (serviceWorkerInUse) {
    downloadServiceWorker.postMessage(
      {
        id: receiving.id,
        type: 'data',
        data: e.data,
        offset: receiving.offset
      },
      [e.data]
    )
  } else {
    receiving.data.set(new Uint8Array(e.data), receiving.offset)
  }

  receiving.offset += chunkSize
  receiving.progress.value = receiving.offset / receiving.size

  if (receiving.offset === receiving.size) {
    if (serviceWorkerInUse) {
      downloadServiceWorker.postMessage({ id: receiving.id, type: 'end' })
    } else {
      triggerDownload(receiving)
    }

    receiving.li.removeChild(receiving.progress)
    receiving = null
  }
}

const connect = async e => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  datachannel = pc.createDataChannel('data', { negotiated: true, id: 0 })
  datachannel.onopen = connected
  datachannel.onmessage = receive
  datachannel.binaryType = 'arraybuffer'
  datachannel.onclose = e => {
    disconnected()
    document.getElementById('info').innerHTML = 'DISCONNECTED'
  }
  datachannel.onerror = e => {
    console.log('datachannel error:', e)
    disconnected()
    document.getElementById('info').innerHTML = 'NETWORK ERROR TRY AGAIN'
  }
  try {
    if (document.getElementById('magiccode').value === '') {
      dialling()
      document.getElementById('info').innerHTML = 'WAITING FOR THE OTHER SIDE - SHARE CODE OR URL'
      const [code, finish] = await newwormhole(pc)
      document.getElementById('magiccode').value = code
      location.hash = code
      const qr = util.qrencode(location.href)
      if (qr === null) {
        document.getElementById('qr').src = ''
      } else {
        document.getElementById('qr').src = URL.createObjectURL(new Blob([qr]))
      }
      await finish
    } else {
      dialling()
      document.getElementById('info').innerHTML = 'CONNECTING'
      await dial(pc, document.getElementById('magiccode').value)
    }
  } catch (err) {
    disconnected()
    if (err === 'bad key') {
      document.getElementById('info').innerHTML = 'BAD KEY TRY AGAIN'
    } else if (err === 'no such slot') {
      document.getElementById('info').innerHTML = 'NO SUCH SLOT'
    } else if (err === 'timed out') {
      document.getElementById('info').innerHTML = 'CODE TIMED OUT GENERATE ANOTHER'
    } else {
      document.getElementById('info').innerHTML = 'COULD NOT CONNECT TRY AGAIN'
    }
  }
}

const dialling = () => {
  document.body.classList.add('dialling')
  document.body.classList.remove('connected')
  document.body.classList.remove('disconnected')

  document.getElementById('dial').disabled = true
  document.getElementById('magiccode').readOnly = true
}

const connected = () => {
  document.body.classList.remove('dialling')
  document.body.classList.add('connected')
  document.body.classList.remove('disconnected')

  document.body.addEventListener('drop', drop)
  document.body.addEventListener('dragenter', highlight)
  document.body.addEventListener('dragover', highlight)
  document.body.addEventListener('drop', unhighlight)
  document.body.addEventListener('dragleave', unhighlight)

  document.getElementById('info').innerHTML = 'OR DRAG FILES TO SEND'

  location.hash = ''
}

const disconnected = () => {
  document.body.classList.remove('dialling')
  document.body.classList.remove('connected')
  document.body.classList.add('disconnected')

  document.getElementById('dial').disabled = false
  document.getElementById('magiccode').readOnly = false
  document.getElementById('magiccode').value = ''

  document.body.removeEventListener('drop', drop)
  document.body.removeEventListener('dragenter', highlight)
  document.body.removeEventListener('dragover', highlight)
  document.body.removeEventListener('drop', unhighlight)
  document.body.removeEventListener('dragleave', unhighlight)

  location.hash = ''

  if (serviceWorkerInUse && receiving) { downloadServiceWorker.postMessage({ id: receiving.id, type: 'error', error: 'rtc disconnected' }) }
}

const highlight = e => {
  document.body.classList.add('highlight')
}

const unhighlight = e => {
  document.body.classList.remove('highlight')
}

const preventdefault = e => {
  e.preventDefault()
  e.stopPropagation()
}

const joining = () => {
  document.getElementById('magiccode').value = location.hash.substring(1)
  document.getElementById('dial').value = 'JOIN WORMHOLE'
  connect()
}

const hashchange = e => {
  if (location.hash.substring(1) !== '' && !(e.newURL && e.newURL.endsWith(document.getElementById('magiccode').value))) {
    joining()
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('magiccode').value = ''
  document.getElementById('magiccode').addEventListener('input', async () => {
    await goready
    if (document.getElementById('magiccode').value === '') {
      document.getElementById('dial').value = 'NEW WORMHOLE'
    } else {
      document.getElementById('dial').value = 'JOIN WORMHOLE'
    }
  })
  document.getElementById('filepicker').addEventListener('change', pick)
  document.getElementById('dialog').addEventListener('submit', preventdefault)
  document.getElementById('dialog').addEventListener('submit', connect)
  document.body.addEventListener('drop', preventdefault)
  document.body.addEventListener('dragenter', preventdefault)
  document.body.addEventListener('dragover', preventdefault)
  document.body.addEventListener('drop', preventdefault)
  document.body.addEventListener('dragleave', preventdefault)
  window.addEventListener('hashchange', hashchange)
  await goready
  if (document.getElementById('magiccode').value === '') {
    document.getElementById('dial').value = 'NEW WORMHOLE'
  } else {
    document.getElementById('dial').value = 'JOIN WORMHOLE'
  }
  if (location.hash.substring(1) !== '') {
    joining()
  } else {
    document.getElementById('dial').disabled = false
  }
})
