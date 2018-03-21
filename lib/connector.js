/*
Descriptor can be:
* url
* id plus token
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

const EventEmitter = require('events').EventEmitter
const extend = require('extend')
const inherits = require('inherits')
const http = require('http')
const SimplePeer = require('simple-peer')
const MovableStream = require('movable-stream')
let wrtc
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

const noop = function (err) {}

const manifest = {
	connectTo: 'duplex',
	connectFrom: 'duplex',
	iceCandidate: 'async',
	sendId: 'sync',
	start: 'sync',
	openStream: 'duplex'
}

const RPC = muxrpc(manifest, manifest)

const CONN_STATES = {
	AWAITING_ID: 0,
	SENT_ID: 1,
	AWAITING_START: 2,
	SENT_START: 3,
	ESTABLISHED: 4, // implies entry in connector.connections
	DESTROYED: 5
}

var Connection = function (connector, stream, peerOpts, opts) {
	var self = this

	self._connector = connector
	self._myId = connector.id
	self._peerOpts = peerOpts
	self._streamRefs = {}
	self._state = null

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

			self._peer.signal(data)
			cb(null)
		},
		sendId: function (id) {
			return self._onSendId(id)
		},
		start: function () {
			return self._onStart()
		},
		openStream: function (name) {
			let duplex = DuplexPair()
			self.emit('stream', name, duplex[0])
			return duplex[1]
		}
	})

	self.on('close', function () {
		if (self.id && connector.connections[self.id] === self)
			delete connector.connections[self.id]

		let idx = connector._connecting.indexOf(self)
		if (idx >= 0) {
			connector._connecting.splice(idx, 1)
		}
	})

	self._conn = new MovableStream(stream)
	let s = self._handle.createStream(function () {
		self._destroy()
	})
	pull(self._conn, s, self._conn)

	self._initialize(opts)
}

inherits(Connection, EventEmitter)

Connection.prototype._initialize = function (opts) {
	let self = this

	const initiator = opts.initiator
	const origId = opts.id
	const introduced = opts.introduced

	let connector = self._connector

	connector._connecting.push(self)

	if (introduced) {
		self.id = origId

		if (initiator) {
			self._sendStart()
		} else {
			self._awaitStart()
		}
	} else {
		if (origId) {
			self.id = origId
		}
		if (initiator) {
			self._state = CONN_STATES.AWAITING_ID
		} else {
			self._state = CONN_STATES.SENT_ID
			console.log('NODE', connector.id, 'SENDING SENDID')
			self._handle.sendId(connector.id, function (err, id) {
				console.log('NODE', connector.id, 'GOT SENDID CB')
				if (!err)
					err = self._verifyId(id)

				if (err)
					return self._destroy(err)

				self.id = id
				self._awaitStart()
			})
		}
	}
}

Connection.prototype._verifyId = function (id) {
	let self = this
	let connector = self._connector

	if (id === connector.id)
		return new Error('connected to node with id same as ours')

	if (self.id && id !== self.id)
		return new Error('id was different from expected')

	return null
}

Connection.prototype._onSendId = function (id) {
	let self = this
	let connector = self._connector

	console.log('NODE', connector.id, 'GOT SENDID')

	if (self._state !== CONN_STATES.AWAITING_ID)
		throw new Error('unexpected sendId call')

	let err = self._verifyId(id)
	if (err)
		return self._destroy(err)

	self.id = id
	process.nextTick(function () {
		// make sure the id response goes out first
		self._sendStart()
	})

	return connector.id
}

Connection.prototype._sendStart = function () {
	let self = this
	let connector = self._connector

	if (connector.connections[self.id])
		return self._replace(connector.connections[self.id])

	for (let i = 0; i < connector._connecting.length; i++) {
		let conn = connector._connecting[i]
		if (conn._state === CONN_STATES.SENT_START)
			return self._replace(conn)
	}

	self._state = CONN_STATES.SENT_START
	console.log('NODE', connector.id, 'SENDING START')
	self._handle.start(function (err, success) {
		console.log('NODE', connector.id, 'GOT START CB')
		if (err)
			return self._destroy(err)

		if (success) {
			self._started()
		} else {
			console.log('start returned false')
			// nothing interesting to see here. this connection should be replaced
			// if it hasn't been already
		}
	})
}

Connection.prototype._awaitStart = function () {
	let self = this
	let connector = self._connector

	self._state = CONN_STATES.AWAITING_START
	if (connector.connections[self.id])
		return self._replace(connector.connections[self.id])
}

Connection.prototype._onStart = function () {
	let self = this
	let connector = self._connector

	console.log('NODE', connector.id, 'GOT START')

	if (self._state !== CONN_STATES.AWAITING_START)
		return false

	// Basic goal: return false iff other connection will succeed
	if (connector.connections[self.id]) {
		console.error('THIS SHOULD BE IMPOSSIBLE! BUG!')
		throw new Error('wtf')
	}

	for (let i = 0; i < connector._connecting.length; i++) {
		let conn = connector._connecting[i]
		if (conn.id === self.id && conn._state === CONN_STATES.SENT_START) {
			console.log('TRICKY CASE')
			if (conn.id > connector.id) {
				self._started()
				return true
			}

			return false
		}
	}

	self._started()
	return true

	// } else if (!connector._connecting[id] || connector._connecting[id]._state !== CONN_STATES.STARTED) {
	// 	console.log('branch 2')
	// 	success = true
	// } else {
	// 	console.log('branch 3', id, id > connector.id)
	// 	replacement = connector._connecting[id]
	// 	success = id > connector.id // If here, there is an entry in _connecting. Let them succeed if their id is larger.
	// }

	// if (success) {
	// 	self._started()
	// } else {
	// 	self._replace(replacement)
	// }

	// return success
}

Connection.prototype._started = function () {
	let self = this
	let connector = self._connector

	self._state = CONN_STATES.ESTABLISHED
	connector.connections[self.id] = self

	let connecting = connector._connecting.slice() // make copy since _replace modifies the array
	for (let i = 0; i < connecting.length; i++) {
		let conn = connecting[i]
		let state = conn._state
		if (self.id === conn.id && (state === CONN_STATES.AWAITING_START || state === CONN_STATES.SENT_START))
			conn._replace(self)
	}

	let idx = connector._connecting.indexOf(self)
	if (idx >= 0) {
		connector._connecting.splice(idx, 1)
	}

	self.emit('_connect', null)
	connector.emit('connection', self)
}

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

const log = require('pull-stream/sinks/log')
const pullOnce = require('pull-stream/sources/once')

Connection.prototype._setupDirectConn = function (initiator) {
	var self = this

	// TODO: fix this
	// if (self._directConn)
	// 	self._directConn.destroy()

	self._directInitiator = initiator
	self._peer = new SimplePeer(extend({}, self._peerOpts, {
		initiator: initiator,
		wrtc: wrtc
	}))
	self._directConn = toPull.duplex(self._peer)

	self._peer.on('signal', function (data) {
		console.log('GOT SIGNAL')
		self._handle.iceCandidate(initiator, data, function (err) {
			if (err) {
				// TODO: close
				console.error(err)
				// self._directConn.close()
				self._directConn = null
				self.emit('_directErr', err)
			}
		})
	})
	var direct = self._directConn
	self._peer.on('connect', function () {
		console.log('GOT CONNECT')
		if (direct === self._directConn) {
			// let old = self._conn.underlying
			self._conn.on('moved', function () {
				// console.log('MOVED; DESTROY')
				self.emit('direct')
				// old.destroy()
				// setTimeout(function () {
				// 	self.emit('direct')
				// }, 1000)

				// self._handle.foobar(41, function (err, bar) {
				// 	console.log('ERR:', err)
				// 	console.log('bar:', bar)
				// })
			// self._directConn.end('ldfadfa')
			})


			// pull(pullOnce('hi across webrtc'), self._directConn, log())

			console.log('MOVING TO')
			self._conn.moveto(self._directConn)

		}
	})
}

Connection.prototype.openStream = function (name) {
	var self = this
	// const streamName = 'app:' + name
	// self._refStream(streamName)

	return self._handle.openStream(name, noop)
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

	if (self._state === CONN_STATES.DESTROYED)
		return
	self._state = CONN_STATES.DESTROYED

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
	self._connecting = []
	self._peerOpts = opts.peer || {}

	if (opts.wsPort) {
		var server = self._httpServer = http.createServer()
		var wss = self._wss = wsServer({
			server: server
		}, function (stream) {
			self._onStreamOpen(stream, {
				initiator:false,
				introduced: false,
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

	Object.keys(self._connecting).forEach(function (conn) {
		conn._destroy(null)
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

	if (!cb)
		throw new Error('wtf')

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

	var conn = new Connection(self, socket, self._peerOpts, opts)

	if (cb)
		self._waitForConnection(conn, cb)
}

// connecting has two substates: ID_KNOWN and SEEN_START

// Connector.prototype._onIdKnown = function (conn, initiator) {
// 	let self = this

// 	const id = conn.id
// 	if (!id) console.error('OMGWTFBBG')
// 	self._state = CONN_STATES.ID_KNOWN

// 	const unknownIndex = self._unknownIdConns.indexOf(conn)
// 	if (unknownIndex >= 0)
// 		self._unknownIdConns.splice(unknownIndex, 1)

// 	// WHAT IF MULTIPLE CONNECTING?
// 	// console.log('SETTING CONNECTING')
// 	// self._connecting[id] = conn

// 	// Always send start (if we're the initiator).
// 	// The other end will throw out duplicates.
// 	if (initiator) {
// 		console.log('SETTING CONNECTING 1')
// 		self._connecting[id] = conn
// 		conn._handle.start(function (err, success) {
// 			// var replacement = self.connections[id] || self._connecting[id]
// 			if (err)
// 				return conn._destroy(err)
// 			// success should be true iff there is no connection yet
// 			console.log('DONIG SUCCESS COMPARISION; success:', success)
// 			if (success === !self.connections[id]) {
// 				if (success) {
// 					self._onConnectionReady(conn)
// 				} else {
// 					// There's already a connection completed
// 					conn._replace(self.connections[id])
// 				}
// 			} else {
// 				conn._destroy(new Error('invalid connection state'))
// 			}
// 		})
// 	} else {
// 		// TODO: what if event is emitted first?
// 		conn.once('_start', function () {
// 			let replacement
// 			if (self.connections[id]) {
// 				console.log('branch 1')
// 				replacement = self.connections[id]
// 				success = false
// 			} else if (!self._connecting[id]) {
// 				console.log('branch 2')
// 				success = true
// 			} else {
// 				console.log('branch 3', id, id > self.id)
// 				success = id > self.id // If here, there is an entry in _connecting. Let them succeed if their id is larger.
// 			}
			
// 			if (success) {
// 				console.log('SETTING CONNECTING 2')
// 				self._connecting[id] = conn // TODO: remove from _unknownIdConns here too?
// 				self._onConnectionReady(conn)
// 			}
// 			conn.emit('_started', null, success)
// 		})
// 	}
// }

// Connector.prototype._onConnectionReady = function (conn) {
// 	var self = this

// 	if (self._connecting[conn.id] === conn)
// 		delete self._connecting[conn.id]

// 	self.connections[conn.id] = conn
// 	conn.emit('_connect')
// 	self.emit('connection', conn)
// }

Connector.prototype._onConnectFrom = function (relay, id) {
	var self = this

	if (id === self.id)
		return {
			source: pullError(new Error('attempt to connect from ourself')),
			sink: noop
		}

	let duplex = DuplexPair()
	self._onStreamOpen(duplex[0], {
		initiator: false,
		introduced: true,
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
	return to._handle.connectFrom(from.id, noop)
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
				initiator: true,
				introduced: false,
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

		// if (self._connecting[id]) {
		// 	// There's already a connection in progress. Use it instead
		// 	self._waitForConnection(self._connecting[id], cb)
		// 	return
		// }

		let stream = descriptor.relay._handle.connectTo(id, noop)
		self._onStreamOpen(stream, {
			initiator: true,
			introduced: true,
			id: id
		}, cb)
	} else {
		throw new Error('not enough data to open a connection')
	}
}
