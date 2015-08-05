
var EventEmitter = require('events').EventEmitter
var inherts = require('inherits')

var rpc = require('rpc-stream')

var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')

//self.connected: boolean
// connecting is self._conn && !self.connected

// may not be connected
// two refcounts: _refcount for any use, _connRefcount for connection
var Peer = function (id, dht) {
	var self = this
	self.dht = dht
	self.id = id
	// self._refcount = 1
	self._conn = null
	self._connRefcount = 0
	self.connected = false
	self.bucketMask = null // dunno which buckets are full yet on this peer

	var api = {}
	Object.keys(dht.rpcHandlers).forEach(function (method) {
		api[method] = dht.rpcHandlers[method].bind(dht, self)
	})

	var rpcInstance = new rpc(api)
	self.handle = rpcInstance.wrap(api)

	self.on('connect', function () {
		self._conn.pipe(rpcInstance).pipe(self._conn)
		self._conn.on('close', function () {
			self.connected = false
			self.emit('close')
		})
		self._conn.on('error', self.emit.bind(self, 'error'))
	})

	dht.peers[id] = self
}

// Peer.prototype.ref = function () {
// 	var self = this
// 	self._refcount++
// 	return self
// }

// Peer.prototype.unref = function () {
// 	var self = this
// 	if (--self._refcount === 0) {
// 		delete self.dht.peers[self.id]
// 		// destroy
// 	}
// }

// given an offer, respond
Peer.prototype.onOffer = function (offer, cb) {
	var self = this
	if (self._conn)
		return cb(new Error('already connected'))

	self._connRefcount++
	// self._refcount++
	self._conn = new SimplePeer({
		trickle: false
	})
	self._conn.signal(offer)
	self._conn.on('signal', function (answer) {
		cb(answer)
	})
	self._conn.on('connect', function () {
		self.connected = true
		self.emit('connect')
	})
}

Peer.prototype.connect = function (bridge, cb) {
	var self = this
	if (cb)
		self.once('connect', cb)
	self._conn = new SimplePeer({
		initiator: true
		trickle: false
	})
	self._conn.on('signal', function (offer) {
		// send to bridge
		bridge.handle.sendOffer(self.id, data, function (err, answer) {
			self._conn.signal(answer)
		})
	})
	self._conn.on('connect', function () {
		self.connected = true
		self.emit('connect')
	})
}

var BootstrapNode = function (url, dht) {
	var self = this
	self.dht = dht
	EventEmitter.prototype.call(self)

	self._conn = new SimpleWebsocket(url)

	var api = {}
	Object.keys(dht.bootstrapRpcHandlers).forEach(function (method) {
		api[method] = dht.bootstrapRpcHandlers[method].bind(dht, self)
	})

	var rpcInstance = new rpc(api)
	self.handle = rpcInstance.wrap(api)

	self._conn.on('connect', function () {
		self._conn.pipe(rpcInstance).pipe(self._conn)
		self.handle.updatePeers(self.dht.getBootstrapPeers(), function (err, peers) {
			if (err) {
				console.error('Failed to get bootstrap nodes')
				return
			}
			self.dht.updateBootstrapPeers(peers)
		})
	})
}

inherits(BootstrapNode, EventEmitter)

var N = 8 // number of nodes to get in one fetch

var DHT = function (id, bootstrap) {
	var self = this
	self.id = id
	self.routingTable = new KBucket() // TODO: construct properly
	self.bucketMask = new BitField(1) // TODO: construct properly

	self.peers = {}

	self.storage = {}

	self.rpcHandlers = {
		findNode: self._onFindNode,
		findValue: self._onFindValue,
		sendOffer: self._onSendOffer,
		offer: self._onOffer,
		getRoutingPeer: self._onGetRoutingPeer,
		updateBucketMask: self._onUpdateBucketMask
	}

	self.bootstrapRpcHandlers = {
		offer: self._onOffer,
		updatePeers: self._onUpdatePeers
	}

	self.bootstrapNodes = bootstrap.forEach(function (url) {
		var node = new BootstrapNode(url, self)
		node.on('peers')
		return node
	})
}

DHT.prototype._getPeer = function (id) {
	var peer = self.peers[id]
	if (peer) {
		return peer //.ref()
	}
	return new Peer(id, self)
}

DHT.prototype._onFindNode = function (from, id, cb) {
	var self = this

	var closest = self.routingTable.closest({
		id: id
	}, N)

	cb(null, closest)
}

DHT.prototype._onFindValue = function (from, id, cb) {
	var self = this

	if (id in self.storage) {
		cb(null, null) // itsMe
	}

	self._onFindNode.apply(arguments)
}

DHT.prototype._onSendOffer = function (from, id, offer, cb) {
	var self = this

	var peer = self._getPeer(id)
	if (!peer.connected) {
		return cb(new Error('no connection'))
	}

	peer.handle.offer(from.id, offer, cb)
}

DHT.prototype._onOffer = function (from, id, offer, cb) {
	// create peer if not exists
	var peer = self._getPeer(id)

	peer.onOffer(offer, cb)
}

DHT.prototype._onGetRoutingPeer = function (from, id, depth, cb) {
	var self = this

	if (depth >= self.bucketMask.length)
		return cb(null, []) // no suggestions for routing

	if (!self.bucketMask.get(depth))
		peers.push(self.id) // we have space ourself

	var bucket = Math.max(self.bucketMask.length - 1, depth)

	// iterate over peers in bucket
	var peers = []
	self.routingTable.getPeers(bucket).forEach(function (id) { // TODO: make this work!
		var peer = self.peers[id]
		if (bucket < peer.bucketMask.length && !peer.bucketMask.get(depth))
			peers.push(peer.id)
	}

	cb(null, peers)
}

DHT.prototype.getBucketMask = function () {
	var self = this
	// self.bucketMask should always be up to date with the bucket status
	return self.bucketMask.buffer.toString('base64')
}

DHT.prototype.updateBucketMask = function (from, mask) {
	var self = this
	from.bucketMask = new Bitfield(new Buffer(mask, 'base64'))
}

DHT.prototype._onUpdateBucketMask = function (from, mask, cb) {
	var self = this
	self._updateBucketMask(from, mask)

	cb(null, self._getBucketMask())
}

DHT.prototype.getBootstrapPeers = function () {
	var self = this

	// TODO: use random peers, not ones near us
	return self.routingTable.closest({
		id: self.id
	}, N)
}

DHT.prototype.updateBootstrapPeers = function (from, peers) {
	var self = this

	// TODO: do something with peers
}

DHT.prototype._onUpdatePeers = function (from, peers, cb) {
	var self = this
	self.updateBootstrapPeers(from, peers)

	cb(null, self.getBootstrapPeers())
}
