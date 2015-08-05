
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var rpc = require('rpc-stream')
var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')


/*
Peers can be:
* Known and have a gateway
* Connecting
* Connected

Essentially, the gateway and connection can exist orthogonally to each other.
If the connection disconnects, peer disappears
If the gateway disappears and there is no connection, peer disappears

gateway can be a peer or bootstrap node


*/

//self.connected: boolean
// connecting is self._conn && !self.connected

// may not be connected
// two refcounts: _refcount for any use, _connRefcount for connection
var Peer = function (id, dht, gateway) {
	var self = this
	self.dht = dht
	self.id = id
	self._conn = null
	self.connected = false
	self.gateway = gateway

	var api = {}
	Object.keys(dht.rpcHandlers).forEach(function (method) {
		api[method] = dht.rpcHandlers[method].bind(dht, self)
	})

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)

	self.on('connect', function () {
		console.log('Got connection to:', id)

		self._conn.pipe(rpcInstance).pipe(self._conn)
		self._conn.on('close', function () {
			self.connected = false
			self._conn = null
			self.emit('close')
		})
		self._conn.on('error', self.emit.bind(self, 'error'))

		// TODO: don't always look ourself up
		self.findNode(dht.id)
	})

	// dht.peers[id] = self
}

inherits(Peer, EventEmitter)

Peer.prototype.sendOffer = function (id, offer, cb) {
	var self = this

	self._handle.sendOffer(id, offer, cb)
}

Peer.prototype.offer = function (fromId, offer, cb) {
	var self = this
	self._handle.offer(fromId, offer, cb)
}

// given an offer, respond
Peer.prototype.onOffer = function (offer, cb) {
	var self = this
	if (self._conn) {
		self._conn.destroy()
		// return cb(new Error('already connected'))
	}

	// self._connRefcount++
	// self._refcount++
	self._conn = new SimplePeer({
		trickle: false
	})
	self._conn.signal(offer)
	self._conn.on('signal', function (answer) {
		cb(null, answer)
	})
	self._conn.on('connect', function () {
		self.connected = true
		self.emit('connect')
	})
}

Peer.prototype.findNode = function (id) {
	var self = this

	self._handle.findNode(id, function (err, nodes) {
		if (err) {
			console.error('Error in findNode:', err)
			return
		}

		self.emit('nodes', self, nodes)
	})
}

Peer.prototype.connect = function (cb) {
	var self = this
	// Ignore duplicate attempts
	if (self._conn)
		return
	// TODO: check gateway is defined/connected
	if (cb)
		self.once('connect', cb)
	self._conn = new SimplePeer({
		initiator: true,
		trickle: false
	})
	self._conn.on('signal', function (offer) {
		// send to gateway
		self.gateway.sendOffer(self.id, offer, function (err, answer) {
			if (err) {
				console.error(err)
				return
			}
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
	EventEmitter.call(self)
	self.dht = dht

	self._conn = new SimpleWebsocket(url)
	self.connected = false

	var api = {}
	Object.keys(dht.bootstrapRpcHandlers).forEach(function (method) {
		api[method] = dht.bootstrapRpcHandlers[method].bind(dht, self)
	})

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(['getNodes', 'sendOffer'])

	self._conn.on('connect', function () {
		self._conn.pipe(rpcInstance).pipe(self._conn)
		self.connected = true

		self._conn.on('close', function () {
			self.connected = false
			self._conn = null
			//TODO: reconnect?
			self.emit('close')
		})
		self._conn.on('error', self.emit.bind(self, 'error'))
		self.emit('connect')
		self.getNodes()
	})
}

inherits(BootstrapNode, EventEmitter)

BootstrapNode.prototype.getNodes = function () {
	var self = this

	self._handle.getNodes(self.dht.id, function (err, nodes) {
		if (err) {
			console.error('Failed to get bootstrap nodes')
			console.error(err.message)
			return
		}
		self.emit('nodes', self, nodes)
	})
}

BootstrapNode.prototype.sendOffer = function (id, offer, cb) {
	var self = this

	self._handle.sendOffer(id, offer, cb)
}

var N = 8 // number of nodes to get in one fetch

var DHT = function (id, bootstrap) {
	var self = this
	self.id = id
	// self.routingTable = new KBucket() // TODO: construct properly
	// self.bucketMask = new BitField(1) // TODO: construct properly

	self.peers = {}

	// self.storage = {}

	self.rpcHandlers = {
		findNode: self._onFindNode,
		// findValue: self._onFindValue,
		sendOffer: self._onSendOffer,
		offer: self._onOffer,
		// getRoutingPeer: self._onGetRoutingPeer,
		// updateBucketMask: self._onUpdateBucketMask
	}

	self.bootstrapRpcHandlers = {
		offer: self._onOffer
	}

	self.bootstrapNodes = bootstrap.forEach(function (url) {
		var node = new BootstrapNode(url, self)
		node.on('nodes', self._onNodes.bind(self))
		return node
	})
}

DHT.prototype._onNodes = function (node, ids) {
	var self = this
	console.log('got peers:', ids)

	var fromBootstrap = node instanceof BootstrapNode
	var gotOne = false
	ids.forEach(function (id) {
		if (id === self.id)
			return
		var peer = self._getPeer(id, node)
		// TODO: don't always connect
		if (!fromBootstrap || !gotOne) {
			console.log('connecting to:', id)
			peer.connect()
		} else {
			console.log('NOT connecting to:', id)
		}
		gotOne = true
	})
}

DHT.prototype._getPeer = function (id, gateway) {
	var self = this
	var peer = self.peers[id]
	if (peer) {
		return peer //.ref()
	}
	peer = new Peer(id, self, gateway)
	peer.on('nodes', self._onNodes.bind(self))
	self.peers[id] = peer
	return peer
}

DHT.prototype._onFindNode = function (from, id, cb) {
	var self = this

	// var closest = self.routingTable.closest({
	// 	id: id
	// }, N)

	var allNodes = Object.keys(self.peers)
	var idBuf = new Buffer(id, 'hex')
	allNodes.sort(function (left, right) {
		var leftBuf = new Buffer(left, 'hex')
		var rightBuf = new Buffer(right, 'hex')
		for (var i = 0; i < 20; i++) {
			var byteXorDelta = leftBuf[i] ^ idBuf[i] - rightBuf[i] ^ idBuf[i]
			if (byteXorDelta)
				return byteXorDelta
		}
		return 0
	})

	var closest = allNodes.slice(0, N)

	console.log('findNode called on us, result:', closest)

	cb(null, closest)
}

// DHT.prototype._onFindValue = function (from, id, cb) {
// 	var self = this

// 	if (id in self.storage) {
// 		cb(null, null) // itsMe
// 	}

// 	self._onFindNode.apply(arguments)
// }

DHT.prototype._onSendOffer = function (from, id, offer, cb) {
	var self = this

	var peer = self._getPeer(id)
	if (!peer.connected) {
		return cb(new Error('no connection'))
	}

	peer.offer(from.id, offer, cb)
}

DHT.prototype._onOffer = function (from, id, offer, cb) {
	var self = this
	// create peer if not exists
	var peer = self._getPeer(id, from)

	peer.onOffer(offer, cb)
}

// DHT.prototype._onGetRoutingPeer = function (from, id, depth, cb) {
// 	var self = this

// 	if (depth >= self.bucketMask.length)
// 		return cb(null, []) // no suggestions for routing

// 	if (!self.bucketMask.get(depth))
// 		peers.push(self.id) // we have space ourself

// 	var bucket = Math.max(self.bucketMask.length - 1, depth)

// 	// iterate over peers in bucket
// 	var peers = []
// 	self.routingTable.getPeers(bucket).forEach(function (id) { // TODO: make this work!
// 		var peer = self.peers[id]
// 		if (bucket < peer.bucketMask.length && !peer.bucketMask.get(depth))
// 			peers.push(peer.id)
// 	}

// 	cb(null, peers)
// }

// DHT.prototype.updateBootstrapPeers = function (from, peers) {
// 	var self = this

// 	// TODO: do something with peers
// }


var id //= localStorage.nodeId

if (!id) {
	id = hat(160)
	localStorage.nodeId = id
}

console.log('my id:', id)


var dht = new DHT(id, ['ws://localhost:8080'])


