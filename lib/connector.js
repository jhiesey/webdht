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
* Refcounting/closing
*/

var Connection = function (myId, stream) {
	var self = this

	self._myId = myId

	Object.defineProperty(self, 'active', {
		get: function () {

		}
	})

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
			}

			self._directConn.signal(data)
			cb(null)
		},
	}

	self._conn = new SwitchableStream(stream)
	self._mux = multiplex({
		chunked: true
	}, function (appStream, name) {
		if (name.slice(0, 4) === 'app:') {
			self.emit('stream', self, name.slice(4), appStream)
		}
	})
	self._conn.pipe(self._mux).pipe(self._conn)
	var rpcStream = self._mux.createSharedStream('rpc')

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)
	rpcStream.pipe(rpcInstance).pipe(rpcStream)
}

/*
	var success
	if (self.connections[id])
		success = false
	else if (!self._connecting[id])
		success = true
	else
		success = id > self.id



*/

Connection.prototype._setupDirectConn = function (initiator) {
	var self = this

	self._directInitiator = initiator
	self._directConn = new SimplePeer({
		initiator: initiator
	})

	self._directConn.on('signal', function (data) {
		self._handle.iceCandidate(initiator, data, function (err) {
			if (err) {
				self.emit('_directErr', err)
				self._directConn.close()
				self._directConn = null
			}
		})
	})
	var direct = self._directConn
	self._directConn.on('connect', function () {
		if (direct === self._directConn)
			self._conn.replace(self._directConn)
	})
}

Connection.prototype.openStream = function (name, shared) {
	var self = this

	if (shared)
		return self._mux.createSharedStream('app:' + name)
	else
		return self._mux.createStream('app:' + name)
}

Connection.prototype.close = function (immediate) {
	var self = this

	if (immediate)
		self._close(null)
	else
		// TODO: handle this case
}

Connection.prototype._close = function (err, ignore) {
	var self = this

	self.emit('close', err, ignore)
}

Connection.prototype.upgrade = function (cb) {
	var self = this

	if (!self._directConn) {
		if (cb) {
			var fired = false
			conn.once('direct', function () {
				if (fired)
					return
				fired = true
				cb(null)
			})
			conn.once('_directErr', function (err) {
				if (fired)
					return
				fired = true
				cb(err)
			})
		}
		self._setupDirectConn(true)
	} else {
		process.nextTick(function () {
			cb(null)
		})
	}
}

var Connector = module.exports = function (id, wsPort, useWebRTC) {
	var self = this

	self.id = id
	self.connections = {}

	if (wsPort) {
		var server = http.createServer()
		var wss = websocket.createServer({
			server: server
		}, function (stream) {
			self._socketConnected(stream, false, function (err) {
				if (err)
					console.error('Error in incoming connection:', err)
			})
		})
		server.listen(wsPort)
	}

}

Connector.prototype._waitForConnection = function (conn, cb) {
	var self = this

	var fired = false
	conn.once('_connect', function () {
		if (fired)
			return
		fired = true
		cb(null, conn)
	})
	conn.once('close', function (err, ignore) {
		if (fired || ignore)
			return
		fired = true
		cb(err, conn)
	})
}

// Purpose of these: call cb with full connection object in every possible case
Connector.prototype._socketConnected = function (stream, initiator, cb) {
	var self = this

	var conn = new Connection (self.id, stream)
	self._preAttachConnection(conn)
	self._waitForConnection(conn, cb)

	if (initiator) {
		// exchange ids
		conn._exchangeIds(function (err, id) {
			if (err)
				return conn._close(err)
			checkId(id)
		})
	} else {
		conn.on('_exchangeIds', function (id) {
			checkId(id)
		})
	}

	var checkId = function (id) {
		if (id === self.id) {
			return conn._close(new Error('connected to node with id same as ours'))
		}

		if (self.connections[id]) {
			// This connection is a duplicate. Use the original instead.
			conn._close(null, true)
			return cb(null, self.connections[id])
		}

		conn.id = id
		if (self._connecting[id]) {
			// There's already a connection in progress. Use it instead
			conn._close(null, true)
			self._waitForConnection(self._connecting[id], cb)
			return
		}

		// Always send start (if we're the initiator).
		// The other end will throw out duplicates.
		if (initiator) {
			self._connecting[id] = conn
			conn._start(function (err, success) {
				if (err)
					conn._close(err)
				else if (success) {
					self._attachConnection(conn)
				} else if (self._connecting[id]) {
					// There's already a connection in progress. Use it instead
					self._waitForSubstituteConnection(self._connecting[id], cb)
				} else {
					conn._close(err)
				}
			})
		} else {
			conn.on('_start', function (cb) {
				if (self.connections[id])
					success = false
				else if (!self._connecting[id])
					success = true
				else
					success = id > self.id // If here, there is an entry in _connecting. Let them succeed if their id is larger.
				
				if (success)
					self._attachConnection(conn)
				return cb(null, success)
			})
		}
	}
}

Connector.prototype._connectTo = function (bridge, id, cb) {
	var self = this

	if (id === self.id)
		return cb(new Error('attempt to connect to ourself'))

	if (self.connections[id]) {
		// This connection is a duplicate. Use the original instead.
		return cb(null, self.connections[id])
	}

	if (self._connecting[id]) {
		// There's already a connection in progress. Use it instead
		self._waitForSubstituteConnection(self._connecting[id], cb)
		return
	}

	var stream = bridge._mux.receiveStream('to:' + id)
	var conn = new Connection(self.id, stream)
	self._preAttachConnection(conn)
	self._waitForConnection(conn, cb)
	conn.id = id
	self._connecting[id] = conn
	bridge._handle.connectTo(id, function (err, success) {
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

Connector.prototype._onConnectFrom = function (bridge, id, cb) {
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
		var stream = bridge._mux.createStream('from:' + id)
		var conn = new Connection(self.id, stream)
		self._preAttachConnection(conn)
		self._waitForConnection(conn, cb)
		conn.id = id
		self._attachConnection(conn)
	}
}

Connector.prototype._preAttachConnection = function (conn) {
	conn.on('close', function () {
		if (conn.id) {
			delete self.connections[conn.id]
			if (self._connecting[conn.id] === conn)
				delete self._connecting[conn.id]
		}
	})
}

Connector.prototype._attachConnection = function (conn) {
	conn.on('connectTo', self._onConnectFrom.bind(self))function (from, id, cb) {
		var to = self.connections[id]
		if (!to)
			return cb(new Error('Unknown node; failed to connect'))

		to._handle.connectFrom(from.id, function (err, success) {
			if (err)
				return cb(err)
			if (!success)
				return cb(null, false)
			var forwardStream = to._mux.receiveStream('from:' + id)
			var backwardStream = from._mux.createStream('to:' + id)
			pump(forwardStream, backwardStream, forwardStream)
		})
	})

	conn.on('connectFrom', self._onConnectFrom.bind(self))

	self.connections[conn.id] = conn
	conn.emit('_connect')
}

/**
 * cb called with connection
 */
Connector.prototype.connectTo = function (descriptor, cb) {
	var self = this

	if (descriptor.url) {
		self._connectToUrl(descriptor.url, function (err, stream) {
			if (err)
				return cb(err)
			self._socketConnected(stream, true, cb)
		})
	} else if (descriptor.id && descriptor.bridge) {
		self._connectTo(descriptor.bridge, descriptor.id, cb)
	} else {
		throw new Error('not enough data to open a connection')
	}
}
