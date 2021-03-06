'use strict'

const multiaddr = require('multiaddr')
const Connection = require('interface-connection').Connection
const os = require('os')
const includes = require('lodash.includes')
const net = require('net')
const toPull = require('stream-to-pull-stream')
const EventEmitter = require('events').EventEmitter
const debug = require('debug')
const log = debug('libp2p:tcp:listen')

const getMultiaddr = require('./get-multiaddr')

const IPFS_CODE = 421
const CLOSE_TIMEOUT = 2000

module.exports = (handler) => {
  const listener = new EventEmitter()

  const server = net.createServer((socket) => {
    const addr = getMultiaddr(socket)
    log('new connection', addr.toString())

    const s = toPull.duplex(socket)
    s.getObservedAddrs = (cb) => {
      return cb(null, [addr])
    }

    trackSocket(server, socket)

    const conn = new Connection(s)
    handler(conn)
    listener.emit('connection', conn)
  })

  server.on('listening', () => {
    listener.emit('listening')
  })

  server.on('error', (err) => {
    listener.emit('error', err)
  })

  server.on('close', () => {
    listener.emit('close')
  })

  // Keep track of open connections to destroy in case of timeout
  server.__connections = {}

  listener.close = (options, cb) => {
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    cb = cb || (() => {})
    options = options || {}

    let closed = false
    server.close(cb)
    server.once('close', () => {
      closed = true
    })
    setTimeout(() => {
      if (closed) return

      log('unable to close graciously, destroying conns')
      Object.keys(server.__connections).forEach((key) => {
        log('destroying %s', key)
        server.__connections[key].destroy()
      })
    }, options.timeout || CLOSE_TIMEOUT)
  }

  let ipfsId
  let listeningAddr

  listener.listen = (ma, cb) => {
    listeningAddr = ma
    if (includes(ma.protoNames(), 'ipfs')) {
      ipfsId = getIpfsId(ma)
      listeningAddr = ma.decapsulate('ipfs')
    }

    const lOpts = listeningAddr.toOptions()
    log('Listening on %s %s', lOpts.port, lOpts.host)
    return server.listen(lOpts.port, lOpts.host, cb)
  }

  listener.getAddrs = (cb) => {
    const multiaddrs = []
    const address = server.address()

    if (!address) {
      return cb(new Error('Listener is not ready yet'))
    }

    // Because TCP will only return the IPv6 version
    // we need to capture from the passed multiaddr
    if (listeningAddr.toString().indexOf('ip4') !== -1) {
      let m = listeningAddr.decapsulate('tcp')
      m = m.encapsulate('/tcp/' + address.port)
      if (ipfsId) {
        m = m.encapsulate('/ipfs/' + ipfsId)
      }

      if (m.toString().indexOf('0.0.0.0') !== -1) {
        const netInterfaces = os.networkInterfaces()
        Object.keys(netInterfaces).forEach((niKey) => {
          netInterfaces[niKey].forEach((ni) => {
            if (ni.family === 'IPv4') {
              multiaddrs.push(multiaddr(m.toString().replace('0.0.0.0', ni.address)))
            }
          })
        })
      } else {
        multiaddrs.push(m)
      }
    }

    if (address.family === 'IPv6') {
      let ma = multiaddr('/ip6/' + address.address + '/tcp/' + address.port)
      if (ipfsId) {
        ma = ma.encapsulate('/ipfs/' + ipfsId)
      }

      multiaddrs.push(ma)
    }

    cb(null, multiaddrs)
  }

  return listener
}

function getIpfsId (ma) {
  return ma.stringTuples().filter((tuple) => {
    return tuple[0] === IPFS_CODE
  })[0][1]
}

function trackSocket (server, socket) {
  const key = `${socket.remoteAddress}:${socket.remotePort}`
  server.__connections[key] = socket

  socket.on('close', () => {
    delete server.__connections[key]
  })
}
