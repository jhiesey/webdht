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
var multiplex = require('multiplex')
var pump = require('pump')
var rpc = require('rpc-stream')
var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')
var MovableStream = require('movable-stream')
var websocket = require('websocket-stream')
var wrtc
try {
	wrtc = require('wrtc')
} catch (e) {}

var Connection = function (myId, stream, peerOpts, isDirect) {
	var self = this

	self._myId = myId
	self._peerOpts = peerOpts
	self._streamRefs = {}

	var api = {
		connectTo: function (id, cb) {
			self.emit('connectTo', self, id, cb)
		},
		connectFrom: function (id, cb) {
			self.emit('connectFrom', self, id, cb)
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
				if (self.id > myId) // Replace if our id is lower than theirs (our outgoing connection will fail)
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
		foobarbaz: function () {
			console.log('FOOBARBAZ')
		}
	}

	self._conn = new MovableStream(stream)
	self._directConn = isDirect ? stream : null
	self._mux = multiplex({
		chunked: true
	}, function (appStream, name) {
		if (name.slice(0, 4) === 'app:') {
			self._refStream(name)
			appStream.on('close', self._unrefStream.bind(self, name))
			appStream.on('finish', self._unrefStream.bind(self, name))
			self.emit('stream', name.slice(4), appStream)
		}
	})
	self._conn.pipe(self._mux).pipe(self._conn)
	self._conn.on('close', self._destroy.bind(self))
	self._conn.on('finish', self._destroy.bind(self))
	self._conn.on('error', self._destroy.bind(self))
	var rpcStream = self._mux.createSharedStream('rpc')
	self._refStream('rpc')

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)
	rpcStream.pipe(rpcInstance).pipe(rpcStream)

	// Object.defineProperty(self, 'children', {
	// 	get: function () {

	// 	}
	// })
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
	self._directConn = new SimplePeer(extend({}, self._peerOpts, {
		initiator: initiator,
		wrtc: wrtc
	}))

	self._directConn.on('signal', function (data) {
		self._handle.iceCandidate(initiator, data, function (err) {
			if (err) {
				self._directConn.close()
				self._directConn = null
				self.emit('_directErr', err)
			}
		})
	})
	var direct = self._directConn
	self._directConn.on('connect', function () {
		if (direct === self._directConn) {
			let old = self._conn.underlying

			// self._directConn.on('data', function (chunk) {
			// 	console.log('CHUNK:', chunk)
			// })


			// let b1 = Buffer.alloc(5)
			// b1[4] = 2
			// self._directConn.write(b1)

			// let b2 = Buffer.alloc(2)
			// b2[0] = 2
			// b2[1] = 20
			// self._directConn.write(b2)

			// self.openStream('fdsafasdfsafsad', true).write('lolol')

			// self._conn.moveto(self._directConn)
			self._conn.on('moved', function () {
				console.log('MOVED; DESTROY')
				// old.destroy()
				self.emit('direct')

				self._handle.foobarbaz()

			// self._directConn.end('ldfadfa')
			})

			self._conn.moveto(self._directConn)
			
		}
	})
}

Connection.prototype.openStream = function (name, shared) {
	var self = this
	const streamName = 'app:' + name
	self._refStream(streamName)

	let stream
	if (shared)
		stream = self._mux.createSharedStream(streamName)
	else
		stream = self._mux.createStream(streamName)

	stream.on('close', self._unrefStream.bind(self, streamName))
	stream.on('finish', self._unrefStream.bind(self, streamName))
	return stream
}

// close only if refs are zero
Connection.prototype.close = function (immediate) {
	var self = this

	self._unrefStream('rpc')
}

Connection.prototype._destroy = function (err, ignore) {
	var self = this

	if (self._destroyed)
		return
	self._destroyed = true

	self._conn.destroy()
	self.emit('close', err, ignore)
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
	self._peerOpts = opts.peer || {}

	if (opts.wsPort) {
		var server = self._httpServer = http.createServer()
		var wss = self._wss = websocket.createServer({
			server: server
		}, function (stream) {
			self._socketConnected(stream, false, function (err) {
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

	var connected = false
	conn.once('_connect', function () {
		connected = true
		cb(null, conn)
	})
	conn.once('close', function (err, ignore) {
		if (connected || ignore)
			return
		cb(err, conn)
	})
}

// Purpose of these: call cb with full connection object in every possible case
Connector.prototype._socketConnected = function (stream, initiator, cb) {
	var self = this

	var conn = new Connection (self.id, stream, self._peerOpts, true)
	self._preAttachConnection(conn)
	self._waitForConnection(conn, cb)

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

	var checkId = function (id) {
		if (id === self.id) {
			return conn._destroy(new Error('connected to node with id same as ours'))
		}

		if (self.connections[id]) {
			// This connection is a duplicate. Use the original instead.
			conn._destroy(null, true)
			return cb(null, self.connections[id])
		}

		if (self._connecting[id]) {
			// There's already a connection in progress. Use it instead
			conn._destroy(null, true)
			self._waitForConnection(self._connecting[id], cb)
			return
		}

		// Always send start (if we're the initiator).
		// The other end will throw out duplicates.
		if (initiator) {
			self._connecting[id] = conn
			conn._handle.start(function (err, success) {
				// var replacement = self.connections[id] || self._connecting[id]
				if (err) {
					conn._destroy(err)
				// success should be true iff there is no connection yet
				} else if (success !== !!self.connections[id]) {
					if (success) {
						self._attachConnection(conn)
					} else {
						conn._destroy(null, true)
						// There's already a connection completed
						cb(null, self.connections[id])						
					}
				} else {
					conn._destroy(new Error('invalid connection state'))
				}
			})
		} else {
			conn.on('_start', function () {
				if (self.connections[id])
					success = false
				else if (!self._connecting[id])
					success = true
				else
					success = id > self.id // If here, there is an entry in _connecting. Let them succeed if their id is larger.
				
				if (success)
					self._attachConnection(conn)
				conn.emit('_started', null, success)
			})
		}
	}
}

Connector.prototype._connectTo = function (relay, id, cb) {
	var self = this

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

	const name = 'to:' + id

	var stream = relay._mux.receiveStream(name)
	relay._refStream(name)
	stream.on('close', relay._unrefStream.bind(relay, name))
	stream.on('finish', relay._unrefStream.bind(relay, name))
	var conn = new Connection(self.id, stream, self._peerOpts, false)
	conn.relay = relay
	self._preAttachConnection(conn)
	self._waitForConnection(conn, cb)
	conn.id = id
	self._connecting[id] = conn
	relay._handle.connectTo(id, function (err, success) {
		if (err)
			conn.close(err)
		else if (success) {
			self._attachConnection(conn)
		} else if (self._connecting[id]) {
			conn.close(null, true)
			self._waitForConnection(self._connecting[id], cb)
		} else {
			conn.close(new Error('no connection in progress but connectTo returned false'))
		}
	})
}

Connector.prototype._onConnectFrom = function (relay, id, cb) {
	var self = this

	if (id === self.id)
		return cb(new Error('attempt to connect from ourself'))

	var success
	if (self.connections[id])
		success = false
	else if (!self._connecting[id])
		success = true
	else
		success = id > self.id

	if (success) {
		const name = 'from:' + id
		var stream = relay._mux.createStream(name)
		relay._refStream(name)
		stream.on('close', relay._unrefStream.bind(relay, name))
		stream.on('finish', relay._unrefStream.bind(relay, name))

		var conn = new Connection(self.id, stream, self._peerOpts, false)
		self._preAttachConnection(conn)
		self._waitForConnection(conn, function (err) {
			cb(err, true)
		})
		conn.id = id
		self._attachConnection(conn)
	}
}

Connector.prototype._preAttachConnection = function (conn) {
	var self = this

	conn.on('close', function () {
		if (conn.id) {
			if (self.connections[conn.id] === conn)
				delete self.connections[conn.id]
			if (self._connecting[conn.id] === conn)
				delete self._connecting[conn.id]
		}
	})
}

Connector.prototype._attachConnection = function (conn) {
	var self = this

	conn.on('connectTo', function (from, id, cb) {
		var to = self.connections[id]
		if (!to)
			return cb(new Error('Unknown node; failed to connect'))

		const forwardName = 'from:' + from.id
		to._refStream(forwardName)
		var forwardStream = to._mux.receiveStream(forwardName)
		forwardStream.on('close', to._unrefStream.bind(to, forwardName))
		forwardStream.on('finish', to._unrefStream.bind(to, forwardName))
		to._handle.connectFrom(from.id, function (err, success) {
			if (err) {
				forwardStream.close()
				return cb(err)
			}
			if (!success) {
				forwardStream.close()
				return cb(null, false)
			}
			const backwardName = 'to:' + id
			from._refStream(backwardName)
			var backwardStream = from._mux.createStream(backwardName)
			backwardStream.on('close', from._unrefStream.bind(from, backwardName))
			backwardStream.on('finish', from._unrefStream.bind(from, backwardName))
			pump(forwardStream, backwardStream, forwardStream)
			cb(null, true)
		})
	})

	conn.on('connectFrom', self._onConnectFrom.bind(self))

	if (self._connecting[conn.id] === conn)
		delete self._connecting[conn.id]

	self.connections[conn.id] = conn
	conn.emit('_connect')
	self.emit('connection', conn)
}

/**
 * cb called with connection
 */
Connector.prototype.connectTo = function (descriptor, cb) {
	var self = this

	if (descriptor.url) {
		var socket = new SimpleWebsocket(descriptor.url)
		var connected = false
		socket.on('connect', function () {
			connected = true
			self._socketConnected(socket, true, function (err, conn) {
				if (!err)
					conn.url = descriptor.url
				cb(err, conn)
			})
		})
		socket.on('error', function (err) {
			if (connected)
				return
			connected = true
			cb(err)
		})
	} else if (descriptor.id && descriptor.relay) {
		self._connectTo(descriptor.relay, descriptor.id, cb)
	} else {
		throw new Error('not enough data to open a connection')
	}
}
