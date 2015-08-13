
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var rpc = require('rpc-stream')
var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')

/*
Concept: Node is base class, BootstrapNode is subclass
Methods:
* connect(direct)
*	'connect'
*	'direct'
* openStream() for clients
* findNode()

*/


/*
Peers can be:
* Known and have a gateway
* Connecting
* Connected

Essentially, the gateway and connection can exist orthogonally to each other.
If the connection disconnects, peer disappears
If the gateway disappears and there is no connection, peer disappears

gateway can be a peer or bootstrap node


ONCE NODE IS CONSTRUCTED, SHOULD BE CONNECTED!
*/

//self.connected: boolean
// connecting is self._conn && !self.connected

// may not be connected
// two refcounts: _refcount for any use, _connRefcount for connection
var Node = function (stream, isDirect, myId) {
	var self = this
	self._myId = myId

	var api = {
		findNode: function (id, cb) {
			self.emit('findNode', self, id, cb)
		},
		connectTo: function (id, cb) {
			var subStream = self._mux.createSharedStream('to:' + id)
			self.emit('connectTo', self, id, subStream, cb)
		},
		connectFrom: function (id, cb) {
			var subStream = self._mux.createSharedStream('from:' + id)
			self.emit('connectFrom', self, id, subStream, cb)
		},
		iceCandidate: function (initiator, data, cb) {
			if (!self._directConn && !initiator) //
				return cb(new Error('Neither side is initiating connection'))
			else if (!self._directConn)
				self._setupDirectConn(false)

			if (initiator && self._rpcIinitator)
				return // TODO: both sides are trying to connect

			self._directConn.signal(data)
			cb(null)
		}
	}

	if (isDirect) {
		self._directConn = self._conn = stream
	} else {
		self._directConn = null
		self._conn = new MovableStream(stream)
	}
	self._mux = multiplex({
		chunked: true
	})
	self._conn.pipe(self._mux).pipe(self._conn)
	var rpcStream = self._mux.createSharedStream('rpc')

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)
	rpcStream.pipe(rpcInstance).pipe(rpcStream)

	self.on('direct', function () {
		self._conn.replace(self._directConn)
	})

	self._conn.on('error', self.emit.bind(self, 'error'))

	self.findNode(myId) // TODO: don't always look ourself up
}

inherits(BaseNode, EventEmitter)

Node.prototype.connectDirect = function (cb) {
	var self = this

	if (cb)
		self.once('direct', cb)

	if (self._directConn)
		return // TODO: call cb?

	self._setupDirectConn(true)
}

Node.prototype._setupDirectConn = function (initiator) {
	var self = this

	self._rpcIinitator = initiator
	self._directConn = new SimplePeer({
		initiator: initiator
	})

	self._directConn.on('signal', function (data) {
		self._handle.iceCandidate(initiator, data, function (err) {
			if (err) {
				console.error(err) // TODO: error handling
			}
		})
	})
	self._directConn.on('connect', function () {
		self.emit('direct')
	})
}

Node.prototype.findNode = function (id, cb) {
	var self = this

	self._handle.findNode(id, cb)
}

// returns stream AND puts it in the callback
Node.prototype.connectTo = function (id, cb) {
	var self = this

	var stream = self._mux.createSharedStream('to:' + id)
	self._handle.connectTo(id, function (err) {
		if (err)
			return cb(err)

		cb(null, stream)
	})

	return stream
}

Node.prototype.connectFrom = function (id, stream, cb) {
	var self = this

	var from = self._mux.createSharedStream('from:' + fromId)
	stream.pipe(from).pipe(stream)
	self._handle.connectFrom(id, cb)
}

SocketNode = function (url, myId) {
	var self = this
	self.url = url
	self.myId = myId


}

var N = 8 // number of nodes to get in one fetch

var DHT = function (id, bootstrapNodes) {
	var self = this
	self.id = id
	self.nodes = {}



}

DHT.prototype._attachNode = function (node) {
	var self = this

	self.nodes[node.id] = node

	node.on('findNode', self.onFindNode.bind(self, id))

	node.on('connectTo', function (from, id, stream, cb) {
		var to = self.nodes[id]
		if (!to)
			return cb('Unknown node; failed to connect')

		to.connectFrom(from.id, stream, cb)
	})

	node.on('connectFrom', function (from, id, stream, cb) {
		if (self.nodes[id])
			return cb('Attempt to connect in both directions') // TODO: what should happen?

		// TODO: don't send stream for websocket nodes. Just connect directly here

		var newNode = new Node(stream, false, self.id)

		self._attachNode(newNode)
	})
}

// TODO: make this depend on the type of connection
DHT.prototype.connect = function (bridge, id, cb) {
	var self = this

	// TODO: don't do this for websocket nodes
	var stream = bridge.connectTo(id, cb)

	var newNode = new Node(stream, false, self.id)

	self._attachNode(newNode)

	return newNode
}

function compareClosestTo (id) {
	var idBuf = new Buffer(id, 'hex')
	nodes = nodes.slice()

	return function (left, right) {
		var leftBuf = new Buffer(left, 'hex')
		var rightBuf = new Buffer(right, 'hex')
		for (var i = 0; i < 20; i++) {
			var byteXorDelta = leftBuf[i] ^ idBuf[i] - rightBuf[i] ^ idBuf[i]
			if (byteXorDelta)
				return byteXorDelta
		}
		return 0	
	}
}

DHT.prototype.getClosest = function (id, nodes) {
	nodes = nodes.slice()
	nodes.sort(compareClosestTo(id))

	return nodes.slice(0, N)
}

DHT.prototype.onFindNode = function (id, cb) {
	var self = this

	var closest = self.getClosest(id, Object.keys(self.nodes))

	console.log('findNode called on us, result:', closest)

	cb(null, closest)
}

function arrEq (arr1, arr2) {
	if (arr1.length !== arr2.length)
		return false
	var len = arr1.length
	for (var i = 0; i < length; i++) {
		if (arr1[i] !== arr2[i])
			return false
	}
	return true
}

var ALPHA = 3

var SEARCH_K = 8

/*
Find non-queried nodes

*/


// calls cb with list of ids
DHT.prototype.findNode = function (id, cb) {
	var self = this

	var closest = Object.keys(self.nodes).map(function (nodeId) {
		return {
			id: nodeId,
			node: self.nodes[id], // either node or origin should be specified
			origin: null,
			startedQuery: false,
			finishedQuery: false
		}
	})

	if (closest.length === 0)
		return cb(new Error('no nodes in routing table'))

	var comparator = compareClosestTo(id)

	function organizeClosest() {
		closest.sort(function (left, right) {
			return comparator(left.id, right.id)
		})
		closest.slice(0, SEARCH_K)
	}
	organizeClosest()

	function makeRequests () {
		var numInProgress = 0
		for (var i = 0; i < closest.length; i++) {
			var entry  = closest[i]
			if (!entry.startedQuery) {
				entry.startedQuery = true
				// connect and query
				if(!entry.node) {
					entry.node = self.connect(entry.origin, entry.id)
				}
				entry.node.findNode(id, function (err, closerIds) {
					entry.finishedQuery = true
					if (err) {
						console.error('error querying node:', entry.id)
						return
					}
					// Push results in
					closerIds.filter(function (closerId) {
						return !closest.any(function (entry) {
							return entry.id === closerId
						})
					})
					var toAdd = closerIds.map(function (closerId) {
						return {
							id: closerId,
							node: null, // Duplicates will have been filtered by now
							origin: entry.node,
							startedQuery: false,
							finishedQuery: false
						}
					})
					closest.push(toAdd)
					organizeClosest()
					makeRequests()
				})
			}
			if (entry.startedQuery && !entry.finishedQuery)
				numInProgress++
			if (numInProgress >= ALPHA)
				break
		}
		if (numInProgress === 0) {
			var result = closest.map(function (entry) {
				return entry.id
			})
			cb(null, result)
		}
	}
	makeRequests()
}




	// var node = self.nodes[id]
	// node.findNode(id, function (err, nodes) {
	// 	if (err)
	// 		return console.error('failed to find node:', err)
	// 	nodes.forEach(function (node) {
	// 		console.log('got node:', node)
	// 	})
	// })
}



// BaseNode.prototype._init = function () {
// 	var self = this


// }

// Peer.prototype.sendOffer = function (id, offer, cb) {
// 	var self = this

// 	self._handle.sendOffer(id, offer, cb)
// }

// Peer.prototype.offer = function (fromId, offer, cb) {
// 	var self = this
// 	self._handle.offer(fromId, offer, cb)
// }

// // given an offer, respond
// Peer.prototype.onOffer = function (offer, cb) {
// 	var self = this
// 	if (self._conn) {
// 		self._conn.destroy()
// 		// return cb(new Error('already connected'))
// 	}

// 	// self._connRefcount++
// 	// self._refcount++
// 	self._conn = new SimplePeer({
// 		trickle: false
// 	})
// 	self._conn.signal(offer)
// 	self._conn.on('signal', function (answer) {
// 		cb(null, answer)
// 	})
// 	self._conn.on('connect', function () {
// 		self.connected = true
// 		self.emit('connect')
// 	})
// }

// Peer.prototype.findNode = function (id) {
// 	var self = this

// 	self._handle.findNode(id, function (err, nodes) {
// 		if (err) {
// 			console.error('Error in findNode:', err)
// 			return
// 		}

// 		self.emit('nodes', self, nodes)
// 	})
// }

// Peer.prototype.connect = function (cb) {
// 	var self = this
// 	// Ignore duplicate attempts
// 	if (self._conn)
// 		return
// 	// TODO: check gateway is defined/connected
// 	if (cb)
// 		self.once('connect', cb)
// 	self._conn = new SimplePeer({
// 		initiator: true,
// 		trickle: false
// 	})
// 	self._conn.on('signal', function (offer) {
// 		// send to gateway
// 		self.gateway.sendOffer(self.id, offer, function (err, answer) {
// 			if (err) {
// 				console.error(err)
// 				return
// 			}
// 			self._conn.signal(answer)
// 		})
// 	})
// 	self._conn.on('connect', function () {
// 		self.connected = true
// 		self.emit('connect')
// 	})
// }

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

	self.nodes = {}

	// self.storage = {}

	// self.rpcHandlers = {
	// 	findNode: self._onFindNode,
	// 	// findValue: self._onFindValue,
	// 	sendOffer: self._onSendOffer,
	// 	offer: self._onOffer,
	// 	// getRoutingPeer: self._onGetRoutingPeer,
	// 	// updateBucketMask: self._onUpdateBucketMask
	// }

	// self.bootstrapRpcHandlers = {
	// 	offer: self._onOffer
	// }

	// self.bootstrapNodes = bootstrap.forEach(function (url) {
	// 	var node = new BootstrapNode(url, self)
	// 	node.on('nodes', self._onNodes.bind(self))
	// 	return node
	// })

	self._onNodes()
}

// DHT.prototype._onNodes = function (node, ids) {
// 	var self = this
// 	console.log('got peers:', ids)

// 	var fromBootstrap = node instanceof BootstrapNode
// 	var gotOne = false
// 	ids.forEach(function (id) {
// 		if (id === self.id)
// 			return
// 		var peer = self._getPeer(id, node)
// 		// TODO: don't always connect
// 		if (!fromBootstrap || !gotOne) {
// 			console.log('connecting to:', id)
// 			peer.connect()
// 		} else {
// 			console.log('NOT connecting to:', id)
// 		}
// 		gotOne = true
// 	})
// }

// DHT.prototype._getPeer = function (id, gateway) {
// 	var self = this
// 	var peer = self.peers[id]
// 	if (peer) {
// 		return peer //.ref()
// 	}
// 	peer = new Peer(id, self, gateway)
// 	peer.on('nodes', self._onNodes.bind(self))
// 	self.peers[id] = peer
// 	return peer
// }

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


