' use strict'

const PREFIX = '/_'

// There can be multiple clients (pages) receiving files, so they generate an id
// and here we store info assosiated with each transfer.
const streams = new Map()

// Repurposing the map...
const waitForMetadata = id => new Promise((resolve, reject) => {
  streams.set(id, { resolve, reject })
})
const signalMetadataReady = (id, streamInfo) => {
  if (streams.has(id)) streams.get(id).resolve(streamInfo)
}

const createStream = (onCancel) => {
  const streamInfo = {}

  streamInfo.stream = new ReadableStream({
    start (controller) {
      streamInfo.controller = controller
    },
    cancel (reason) {
      onCancel(reason)
    }
  })

  return streamInfo
}

self.addEventListener('message', event => {
  const message = event.data
  const id = message.id

  if (message.type === 'metadata') {
    const { name, size } = message

    // TODO propagate cancellation back to main window and sender.
    const onCancel = cancelReason => console.warn('Stream cancelled', cancelReason)
    const streamInfo = { name, size, ...createStream(onCancel) }

    // Resolve promise if GET request arrived first.
    signalMetadataReady(id, streamInfo)

    streams.set(id, streamInfo)
  } else {
    const streamInfo = streams.get(id)

    if (message.type === 'data') {
      streamInfo.controller.enqueue(new Uint8Array(message.data))
    } else if (message.type === 'end') {
      streamInfo.controller.close()

      // Synchronize with fetch handler to clean up properly.
      if (streamInfo.requestHandled) { streams.delete(id) } else streamInfo.streamHandled = true
    } else if (message.type === 'error') {
      streamInfo.controller.error(message.error)
    }
  }
})

const encodeFilename = filename =>
  encodeURIComponent(filename)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\(/g, '%29')
    .replace(/\*/g, '%2A')

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Sanity test.
  if (event.request.method !== 'GET' || !new RegExp(`^${PREFIX}/[^/]+$`).test(url.pathname)) return

  event.respondWith((async () => {
    const id = url.pathname.split('/')[2]

    // Request may arrive before metadata.
    const streamInfo = streams.get(id) || await waitForMetadata(id)

    // Synchronize with message handler end to clean up properly.
    if (streamInfo.streamHandled) { streams.delete(id) } else streamInfo.requestHandled = true

    const { size, name, stream } = streamInfo

    console.log(`serving ${name} (${id})`)

    // Thanks to https://github.com/jimmywarting/StreamSaver.js for proper headers.
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream; charset=utf-8',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeFilename(name)}`
      }
    })
  })())
})
