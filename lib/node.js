var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var multiplex = require('multiplex')
var once = require('once')
var pump = require('pump')
var rpc = require('rpc-stream')
var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')

var MovableStream = require('movable-stream')

var MAX_NESTING_DEPTH = 2

/*
Simultaneity problems:
	* Both try to connect simultaneously
		* Two indirect streams
		* one direct and one indirect stream
		* two direct streams (weird, but if both are servers could happen)

		In all 


		* if ids are known, higher id wins
		* if not known, wait. still higher id wins
		WAIT: what happens with things with a reference to the old node???
	* Both try to upgrade simultaneously -> internal to node
		* higher id wins
*/

var ACTIVE_TIME = 10 // seconds

var Node = module.exports = function (opt, myId) {
	var self = this
	self.id = null // may be set right after constructor, but not necessarily
	self._myId = myId

	var stream
	// var isDirect = true
	if (opt.url) {
		stream = new SimpleWebsocket(opt.url)
		self.url = opt.url
		self.relay = null
	} else if (opt.connection) {
		stream = opt.connection
		self.relay = opt.relay || null // may be direct or indirect
	} else if (opt.relay && opt.id) {
		self.relay = opt.relay
		stream = self.relay.connectTo(opt.id)
	} else {
		throw new Error('Not enough information to construct node')
	}

	self.active = {
		neighbor: false,
		substream: 0,
		query: 0
	}

	var api = {
		findNode: function (id, cb) {
			self._refQuery()
			self.emit('findNode', self, id, cb)
		},
		connectTo: function (id, cb) {
			var substream = self._mux.createStream('to:' + id)
			self._refSubstream(substream) // TODO: this may be bad for us if the neighbors are greedy
			self.emit('connectTo', self, id, substream, cb)
		},
		connectFrom: function (id, cb) {
			var substream = self._mux.createStream('from:' + id)
			self._refSubstream(substream) // TODO: this may be bad for us if the neighbors are greedy
			self.emit('connectFrom', self, id, substream, cb)
		},
		iceCandidate: function (initiator, data, cb) {
			// Here be dragons! the logic here is much more complex than meets the eye. If initiator && self._rpcInitiator,
			// we need to replace the stream. this will set self._rpcInitiator false, so it won't run again
			if (!self._directConn && !initiator) //
				return cb(new Error('Neither side is initiating connection'))
			else if (!self._directConn)
				self._setupDirectConn(false)
			else if (initiator && self._rpcInitiator) {
				// we will never initiate before the id is known, so self.id must be set
				// Ignore if our id is higher than theirs (our outgoing connection will win)
				if ((new Buffer(self.id, 'hex')).compare(new Buffer(self._myId, 'hex')) < 0)
					return
				else // Replace if our id is lower than theirs (our outgoing connection will fail)
					self._setupDirectConn(false)
			}

			self._directConn.signal(data)
			cb(null)
		},
		getId: function (cb) {
			cb(null, self._myId)
		}
	}

	if (!self.relay) {
		self._directConn = stream
	} else {
		self._directConn = null
	}
	self._conn = new MovableStream(stream)
	self._mux = multiplex({
		chunked: true
	}, function (appStream, name) {
		if (name.slice(0, 4) === 'app:') {
			var emitStream = function () {
				self.emit('appStream', self.id, name.slice(4), appStream)
			}
			if (!self.id)
				self.on('idSet', emitStream)
			else
				emitStream()
		}
	})
	self._conn.pipe(self._mux).pipe(self._conn)
	var rpcStream = self._mux.createSharedStream('rpc')

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)
	rpcStream.pipe(rpcInstance).pipe(rpcStream)

	self.on('direct', function () {
		self.replaceStream(self._directConn)
		self.relay = null
	})

	self._conn.on('close', self.destroy.bind(self, null))
	self._conn.on('error', self.destroy.bind(self, 'error'))

	// TODO: is this really the right logic?
	Object.defineProperty(self, 'isDirect', {
		get: function () {
			return !self.relay
		}
	})

	Object.defineProperty(self, 'tryingDirect', {
		get: function () {
			return !!self._directConn
		}
	})

	Object.defineProperty(self, 'isActive', {
		get: function () {
			return Object.keys(self.active).all(function (entry) {
				return !self.active[entry]
			})
		}
	})

	// TODO: should depth be measured by current or planned depth?
	Object.defineProperty(self, 'depth', {
		get: function () {
			var depth = 0
			node = self
			while (!node._directConn) {
				node = node.relay
				depth++
			}
			return depth
		}
	})

	if (opt.id) {
		self.id = opt.id
		process.nextTick(self.emit.bind(self, 'idSet'))
	} else {
		self._handle.getId(function (err, id) {
			if (err) {
				console.error('failed to get id for node!')
				self.destroy()
				return
			}
			self.id = id
			self.emit('idSet')
		})
	}

	self.on('idSet', function () {
		if (self.depth > MAX_NESTING_DEPTH)
			self.connectDirect()
	})
}

inherits(Node, EventEmitter)

// add and remove handlers to 'destroy' to do appropriate cleanup
Node.prototype.destroy = function (err) {
	var self = this
	if (self._destroyed)
		return

	self._destroyed = true
	self._conn.destroy()
	self.emit('destroy', err)
}

Node.prototype.connectDirect = function () {
	var self = this
	if (self._directConn)
		return

	self._setupDirectConn(true)
}

// Can only call once per stream. returns unref function.
Node.prototype._refSubstream = function (stream) {
	var self = this

	var unrefed = false
	var unref = function () {
		if (unrefed)
			return
		unrefed = true
		self.active.substream--
	}

	// auto-unref
	stream.on('error', unref)
	stream.on('end', unref)
	return unref
}

Node.prototype._refQuery = function () {
	var self = this

	self.active.query++
	setTimeout(function () {
		self.active.query--
	}, ACTIVE_TIME * 1000)
}

Node.prototype.createAppStream = function (name) {
	var self = this

	var stream = self._mux.createStream('app:' + name)
	self._refSubstream(stream)

	return stream
}

Node.prototype.replaceStream = function (newStream) {
	var self = this
	self._conn.moveto(newStream)
}

Node.prototype._setupDirectConn = function (initiator) {
	var self = this

	// Must be stored so we can remove the listener if needed
	self._emitDirect = self._emitDirect || self.emit.bind(self, 'direct')

	// This handles cleaning up if we're replacing another direct connection
	if (self._directConn)
		self._directConn.removeListener('connect', self._emitDirect)

	self._rpcInitiator = initiator
	self._directConn = new SimplePeer({
		initiator: initiator
	})

	self._directConn.on('signal', function (data) {
		self._handle.iceCandidate(initiator, data, function (err) {
			if (err) {
				console.error('error in ice candidate:', err)
				self.destroy() // TODO: is there something better we can do?
			}
		})
	})
	self._directConn.on('connect', self._emitDirect)
}

var LOOKUP_TIMEOUT = 10

Node.prototype.findNode = function (id, cb) {
	var self = this

	cb = once(cb)
	var timeout = setTimeout(function () {
		cb(new Error('timeout'))
	}, LOOKUP_TIMEOUT * 1000)

	self._handle.findNode(id, function (err, descriptors) {
		clearTimeout(timeout)
		cb(err, descriptors)
	})
}

Node.prototype.connectTo = function (id) {
	var self = this

	var stream = self._mux.receiveStream('to:' + id)
	var unref = self._refSubstream(stream)
	self._handle.connectTo(id, function (err, connected) {
		if (err) {
			unref()
			console.error('error in connectTo:', err)
		}
	})

	return stream
}

Node.prototype.connectFrom = function (id, stream, cb) {
	var self = this

	var from = self._mux.receiveStream('from:' + id)
	var unref = self._refSubstream(from)
	pump(from, stream, from, function (err) {
		unref()
		err = (!err || err.message === 'premature close') ? null : err
		if (err) {
			console.error('error in connectFrom:', err)
		}
	})
	self._handle.connectFrom(id, cb)
}