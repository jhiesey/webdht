/*
Descriptor can be:
* url
* id plus token

Operations:
* descriptor to stream
* descriptor to token


Really now!
Connector.prototype.connectTo(descriptor, cb)

descriptor is url or id + connection
cb called with connection (deduplicated)

Connection.prototype.openStream(name): stream returned
Connection.prototype.upgrade(cb): cb called when upgraded
Connection.prototype.close(immediate): if immediate, close now. otherwise close when streams done


Guess what!? the same interface would work for the overlay network if we eliminate the connection
in the descriptor!
*/

/*
What's left:
* TODO: Refcounting/closing
	* keep per-stream data
	* stream.name gives name
	* also keep count for 'rpc' stream
* TODO: encryption/signing
* pull streams: muxrpc

Need explicit management of connection refs
* per stream (can be weak)
	* open stream
	* unref stream
	* close stream

* also when stuff multiplexed on top
	* unref once direct


*/

var EventEmitter = require('events').EventEmitter
var extend = require('extend')
var inherits = require('inherits')
var http = require('http')
var SimplePeer = require('simple-peer')
var MovableStream = require('movable-stream')
var wrtc
try {
	wrtc = require('wrtc')
} catch (e) {}

const muxrpc = require('muxrpc')
const pull = require('pull-stream')
const wsClient = require('pull-ws/client')
const wsServer = require('pull-ws/server')
const DuplexPair = require('pull-pair/duplex')
const toPull = require('stream-to-pull-stream')
const pullError = require('pull-stream/sources/error')
const pullEmpty = require('pull-stream/sources/empty')

const dummySink = function (read) {}

const manifest = {
	connectTo: 'duplex',
	connectFrom: 'duplex',
	iceCandidate: 'async',
	exchangeIds: 'async',
	start: 'async',
	openStream: 'duplex'
}

const RPC = muxrpc(manifest, manifest)

var Connection = function (connector, stream, peerOpts, isDirect) {
	var self = this

	self._connector = connector
	self._myId = connector.id
	self._peerOpts = peerOpts
	self._streamRefs = {}

	self._handle = RPC({
		connectTo: function (id) {
			return self._connector._onConnectTo(self, id)
		},
		connectFrom: function (id) {
			return self._connector._onConnectFrom(self, id)
		},
		iceCandidate: function (initiator, data, cb) {
			// Here be dragons! the logic here is much more complex than meets the eye. If initiator && self._directInitiator,
			// we need to replace the stream. this will set self._directInitiator false, so it won't run again
			if (!self._directConn && !initiator) //
				return cb(new Error('Neither side is initiating connection'))
			else if (!self._directConn)
				self._setupDirectConn(false)
			else if (initiator && self._directInitiator) {
				// we will never initiate before the id is known, so self.id must be set
				// Ignore if our id is higher than theirs (our outgoing connection will win)
				if (self.id > connector.id) // Replace if our id is lower than theirs (our outgoing connection will fail)
					self._setupDirectConn(false)
				else
					return
			}

			self._directConn.signal(data)
			cb(null)
		},
		exchangeIds: function (id, cb) {
			if (self.id && id !== self.id)
				return cb(new Error('got multiple ids for the same node'))
			self.id = id
			cb(null, self._myId)
			self.emit('_exchangeIds')
		},
		start: function (cb) {
			self.once('_started', cb)
			self.emit('_start')
		},
		openStream: function (name) {
			let duplex = DuplexPair()
			self.emit('stream', duplex[0])
			return duplex[1]
		}
	})

	self.on('close', function () {
		if (self.id) {
			if (connector.connections[self.id] === self)
				delete connector.connections[self.id]
			if (connector._connecting[self.id] === self)
				delete connector._connecting[self.id]
		}
	})

	self._conn = new MovableStream(stream)
	let s = self._handle.createStream(function () {
		self._destroy()
	})
	pull(self._conn, s, self._conn)
}

inherits(Connection, EventEmitter)

Connection.prototype._refStream = function (name) {
	let self = this

	if (self._streamRefs[name])
		throw new Error('duplicate stream')

	self._streamRefs[name] = 1
}

// stream 
Connection.prototype._unrefStream = function (name) {
	let self = this

	if (self._streamRefs[name])
		delete self._streamRefs[name]

	const total = Object.keys(self._streamRefs).length
	if (total === 0) {
		self._destroy()
	}
}

Connection.prototype._exchangeIds = function (cb) {
	var self = this

	self._handle.exchangeIds(self._myId, function (err, id) {
		if (err)
			return cb(err)
		if (self.id && id !== self.id)
			return cb(new Error('got multiple ids for the same node'))
		self.id = id
		cb(null)
	})
}

Connection.prototype._setupDirectConn = function (initiator) {
	var self = this

	if (self._directConn)
		self._directConn.destroy()

	self._directInitiator = initiator
	self._peer = new SimplePeer(extend({}, self._peerOpts, {
		initiator: initiator,
		wrtc: wrtc
	}))
	self._directConn = toPull(self._peer)

	self.peer.on('signal', function (data) {
		self._handle.iceCandidate(initiator, data, function (err) {
			if (err) {
				self._directConn.close()
				self._directConn = null
				self.emit('_directErr', err)
			}
		})
	})
	var direct = self._directConn
	self.peer.on('connect', function () {
		if (direct === self._directConn) {
			let old = self._conn.underlying
			self._conn.on('moved', function () {
				console.log('MOVED; DESTROY')
				// old.destroy()
				self.emit('direct')

			// self._directConn.end('ldfadfa')
			})

			self._conn.moveto(self._directConn)

		}
	})
}

Connection.prototype.openStream = function (name) {
	var self = this
	// const streamName = 'app:' + name
	// self._refStream(streamName)

	return self._handle.openStream(name)
}

// close only if refs are zero
Connection.prototype.close = function (immediate) {
	var self = this

	self._unrefStream('rpc')
}

Connection.prototype._replace = function (replacement) {
	let self = this

	self.emit('replace', replacement)
	self._destroy()
}

Connection.prototype._destroy = function (err) {
	var self = this

	if (self._destroyed)
		return
	self._destroyed = true

	// self._conn.destroy()
	self.emit('close', err)
}

Connection.prototype.upgrade = function (cb) {
	var self = this

	if (!self._directConn) {
		if (cb) {
			var fired = false
			self.once('direct', function () {
				if (fired)
					return
				fired = true
				cb(null)
			})
			self.once('_directErr', function (err) {
				if (fired)
					return
				fired = true
				cb(err)
			})
		}
		self._setupDirectConn(true)
	} else if (cb) {
		process.nextTick(function () {
			cb(null)
		})
	}
}

// TODO: change overlay and tests to match new interface
var Connector = module.exports = function (opts) {
	var self = this

	self.id = opts.id
	self.connections = {}
	self._connecting = {}
	self._unknownIdConns = []
	self._peerOpts = opts.peer || {}

	if (opts.wsPort) {
		var server = self._httpServer = http.createServer()
		var wss = self._wss = wsServer({
			server: server
		}, function (stream) {
			self._onStreamOpen(stream, {
				initiator:false
			}, function (err) {
				if (err)
					console.error('Error in incoming connection:', err)
			})
		})
		server.listen(opts.wsPort)
	}
}

inherits(Connector, EventEmitter)

Connector.prototype.destroy = function () {
	var self = this

	if (self._destroyed)
		return

	self._destroyed = true

	self._unknownIdConns.forEach(function (conn) {
		conn._destroy()
	})

	Object.keys(self._connecting).forEach(function (id) {
		self._connecting[id]._destroy(null)
	})
	Object.keys(self.connections).forEach(function (id) {
		self.connections[id]._destroy(null)
	})

	if (self._httpServer) {
		self._httpServer.close()
		self._wss.close()
	}
}

Connector.prototype._waitForConnection = function (conn, cb) {
	var self = this

	conn.once('replace', function (replacement) {
		if (connected)
			return
		self._waitForConnection(replacement, cb)
	})

	var connected = false
	conn.once('_connect', function () {
		connected = true
		cb(null, conn)
	})
	conn.once('close', function (err) {
		if (connected)
			return
		cb(err, conn)
	})
}

/*
State machine questions:
* why are _exchangeIds and _start separate?
* why is the same logic in _start and opening connections?
	-> two separate code paths depending on type of connection
	-> should REFACTOR out this uniqueness logic
* cleaner(?): support multiple connections transiently
* add ws stuff along with ice candidates?
	-> upgrade to ws




*/


// Purpose of these: call cb with full connection object in every possible case
// call once connection opened

/*
Creates and sets up connection. Updates state about the connection as well.

Connections go:
_onStreamOpen -> _onIdKnown -> _onConnectionReady -> ready -> destroyed
At any point we can destroy a connection early.
This happens


TODO:
* update connection lists
* set handlers on connection
* make waitForConnection that actually works

CASES:
* if we know id, set self._opening[id] = conn
* otherwise, set self._openingNoId.push(conn)

GUARANTEES:
* if self._opening[id] is defined, self._waitForConnection(id, cb) will fire
	when it or its replacement is ready

*/
Connector.prototype._onStreamOpen = function (socket, opts, cb) {
	var self = this

	const initiator = opts.initiator
	const id = opts.id

	var conn = new Connection(self, socket, self._peerOpts, true)
	conn.on('close', function () {
		const unknownIndex = self._unknownIdConns.indexOf(conn)
		if (unknownIndex >= 0)
			self._unknownIdConns.splice(unknownIndex, 1)

		if (conn.id) {
			if (self._connecting[conn.id] === conn)
				delete self._connecting[conn.id]
			if (self.connections[conn.id] === conn)
				delete self.connections[conn.id]
		}
	})

	self._waitForConnection(conn, cb)

	if (id) {
		self._onIdKnown(conn, initiator)
	} else {
		self._unknownIdConns.push(conn)
		if (initiator) {
			// exchange ids
			conn._exchangeIds(function (err) {
				if (err)
					return conn._destroy(err)
				checkId(conn.id)
			})
		} else {
			conn.on('_exchangeIds', function () {
				checkId(conn.id)
			})
		}
	}

	var checkId = function (id) {
		if (id === self.id) {
			return conn._destroy(new Error('connected to node with id same as ours'))
		}

		if (self.connections[id]) {
			// This connection is a duplicate. Use the original instead.
			conn._destroy()
			return cb(null, self.connections[id])
		}

		if (self._connecting[id]) {
			// There's already a connection in progress. Use it instead
			conn._replace(self._connecting[id])
			return
		}

		self._onIdKnown(conn, initiator)
	}
}

Connector.prototype._onIdKnown = function (conn, initiator) {
	let self = this

	const id = conn.id

	const unknownIndex = self._unknownIdConns.indexOf(conn)
	if (unknownIndex >= 0)
		self._unknownIdConns.splice(unknownIndex, 1)

	// WHAT IF MULTIPLE CONNECTING?
	self._connecting[id] = conn

	// Always send start (if we're the initiator).
	// The other end will throw out duplicates.
	if (initiator) {
		self._connecting[id] = conn
		conn._handle.start(function (err, success) {
			// var replacement = self.connections[id] || self._connecting[id]
			if (err)
				return conn._destroy(err)
			// success should be true iff there is no connection yet
			console.log('SUCCESS:', success)
			console.log('HAVE CONNECTION:', !!self.connections[id])
			if (success === !self.connections[id]) {
				if (success) {
					self._onConnectionReady(conn)
				} else {
					// There's already a connection completed
					conn._replace(self.connections[id])
				}
			} else {
				conn._destroy(new Error('invalid connection state'))
			}
		})
	} else {
		// TODO: what if event is emitted first?
		conn.once('_start', function () {
			let replacement
			if (self.connections[id]) {
				console.log('branch 1')
				replacement = self.connections[id]
				success = false
			} else if (!self._connecting[id]) {
				console.log('branch 2')
				success = true
			} else {
				console.log('branch 3')
				success = id > self.id // If here, there is an entry in _connecting. Let them succeed if their id is larger.
			}
			
			if (success) {
				self._onConnectionReady(conn)
			}
			conn.emit('_started', null, success)
		})
	}
}

Connector.prototype._onConnectionReady = function (conn) {
	var self = this

	if (self._connecting[conn.id] === conn)
		delete self._connecting[conn.id]

	self.connections[conn.id] = conn
	conn.emit('_connect')
	self.emit('connection', conn)
}

Connector.prototype._onConnectFrom = function (relay, id) {
	var self = this

	if (id === self.id)
		return {
			source: pullError(new Error('attempt to connect from ourself')),
			sink: dummySink
		}

	let duplex = DuplexPair()
	self._onStreamOpen(duplex[0], {
		initiator: false,
		id: id
	})

	return duplex[1]
}

Connector.prototype._onConnectTo = function (from, id) {
	let self = this

	var to = self.connections[id]
	if (!to)
		throw new Error('Unknown node; failed to connect')

	// TODO: ref streams
	return to._handle.connectFrom(from.id)	
}

/**
 * cb called with connection
 */
Connector.prototype.connectTo = function (descriptor, cb) {
	var self = this

	if (descriptor.url) {
		var connected = false
		wsClient(descriptor.url, function (err, stream) {
			if (err) return cb(err)

			connected = true
			self._onStreamOpen(stream, {
				initiator: true
			}, function (err, conn) { // want to call with successful connection (or error)
				if (!err)
					conn.url = descriptor.url
				cb(err, conn)
			})	
		})
	} else if (descriptor.id && descriptor.relay) {
		const id = descriptor.id
		if (id === self.id)
			return cb(new Error('attempt to connect to ourself'))

		if (self.connections[id]) {
			// This connection is a duplicate. Use the original instead.
			return cb(null, self.connections[id])
		}

		if (self._connecting[id]) {
			// There's already a connection in progress. Use it instead
			self._waitForConnection(self._connecting[id], cb)
			return
		}

		let stream = relay._handle.connectTo(id)
		self._onStreamOpen(stream, {
			initiator: true,
			id: id
		}, cb)
	} else {
		throw new Error('not enough data to open a connection')
	}
}
