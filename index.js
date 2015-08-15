
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var http = require('http')
var inherits = require('inherits')
var rpc = require('rpc-stream')
var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')
var websocket = require('websocket-stream')
var SwitchableStream = require('./switchable-stream')
var multiplex = require('multiplex')

/*
TODO list:
* handle both sides trying to connect
* proper routing table
* ref counting
*/

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
		},
		getId: function (cb) {
			cb(null, myId)
		}
	}

	if (isDirect) {
		self._directConn = self._conn = stream
	} else {
		self._directConn = null
		self._conn = new SwitchableStream(stream)
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

	Object.defineProperty(self, 'isDirect', {
		get: function () {
			return !!self._directConn
		}
	})

	// self.findNode(myId) // TODO: don't always look ourself up
}

inherits(Node, EventEmitter)

Node.prototype.getId = function (cb) {
	var self = this

	self._handle.getId(cb)
}

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
				console.error('error in ice candidate:', err) // TODO: error handling
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
Node.prototype.connectTo = function (id) {
	var self = this

	var stream = self._mux.createSharedStream('to:' + id)
	self._handle.connectTo(id, function (err) {
		if (err)
			console.error('error in connectTo:', err)
			// return cb(err)

		// cb(null, stream)
	})

	return stream
}

Node.prototype.connectFrom = function (id, stream, cb) {
	var self = this

	var from = self._mux.createSharedStream('from:' + id)
	stream.pipe(from).pipe(stream)
	self._handle.connectFrom(id, cb)
}

// SocketNode = function (url, myId) {
// 	var self = this
// 	self.url = url
// 	self.myId = myId


// }

var N = 8 // number of nodes to get in one fetch

var DHT = function (id, bootstrapNodes, listenPort) {
	var self = this
	self.id = id
	self.nodes = {}

	self.nodesByUrl = {}

	if (listenPort) {
		var server = http.createServer()
		var wss = websocket.createServer({
			server: server
		}, function (stream) {
			self.connect({
				directStream: stream
			})
		})
		server.listen(listenPort)
	}

	bootstrapNodes = bootstrapNodes || []
	bootstrapNodes.forEach(function (url) {
		self.connect({
			url: url
		})
	})
}

DHT.prototype._attachNode = function (node) {
	var self = this

	node.on('findNode', self.onFindNode.bind(self))

	node.on('connectTo', function (from, id, stream, cb) {
		var to = self.nodes[id]
		if (!to)
			return cb('Unknown node; failed to connect')

		to.connectFrom(from.id, stream, cb)
	})

	node.on('connectFrom', function (from, id, stream, cb) {
		if (self.nodes[id])
			return cb('Attempt to connect in both directions') // TODO: what should happen?

		self.connect({
			id: id,
			webrtc: true,
			indirectStream: stream,
		})
	})
}

/*
REAL descriptor (over the wire): {
	url: 'wss://foo.bar',
	id: '1234abcd'
}

*/

/*
socket descriptor: {
	url: 'wss://foo.bar', // optional
	id: '1234abcd', // optional, required if webrtc is specified
	bridge: Node // optional; one of stream or bridge must be provided if webrtc and !url
	indirectStream: DuplexStream // optional; one of stream or bridge must be provided if webrtc and !url
	directStream: DuplexStream // optional; provided for websocket server case
}
*/

DHT.prototype.connect = function (descriptor, cb) {
	var self = this

	if (descriptor.id && self.nodes[descriptor.id])
		console.error('already connected')
		// TODO: handle this properly

	if (descriptor.url && self.nodes[descriptor.url])
		console.error('already connected')
		// TODO: handle this properly

	var stream
	var newNode
	if (descriptor.url) {
		stream = new SimpleWebsocket(descriptor.url)
		newNode = new Node(stream, true, self.id)
		newNode.url = descriptor.url
		stream.on('connect', function () {
			newNode.getId(function (err, id) {
				if (!err) {
					self.nodes[id] = newNode
					newNode.id = id
				}
				console.log('connected (url) to node with id:', id)
				// cb(err, newNode)
			})
		})
		self.nodesByUrl[descriptor.url] = newNode 
		self._attachNode(newNode)
	} else if (descriptor.directStream) {
		stream = descriptor.directStream
		newNode = new Node(stream, true, self.id)
		newNode.getId(function (err, id) {
			if (!err) {
				self.nodes[id] = newNode
				newNode.id = id
			}
			console.log('connected (dir stream) to node with id:', id)
			// cb(err, newNode)
		})
		self._attachNode(newNode)
	} else if (descriptor.indirectStream) {
		stream = descriptor.indirectStream
		newNode = new Node(stream, false, self.id)
		self.nodes[descriptor.id] = newNode
		newNode.id = descriptor.id
		console.log('connected (ind stream) to node with id:', descriptor.id)
		self._attachNode(newNode)
	} else if (descriptor.bridge) {
		stream = descriptor.bridge.connectTo(descriptor.id)//, cb)
		newNode = new Node(stream, false, self.id)
		self.nodes[descriptor.id] = newNode
		newNode.id = descriptor.id
		console.log('connected (bridge) to node with id:', descriptor.id)
		self._attachNode(newNode)
	}

	return newNode
}

function compareClosestTo (id) {
	var idBuf = new Buffer(id, 'hex')

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

DHT.prototype.onFindNode = function (node, id, cb) {
	var self = this

	var closest = self.getClosest(id, Object.keys(self.nodes))

	var nodes = closest.map(function (nodeId) {
		var node = self.nodes[nodeId]
		var ret = {
			id: nodeId,
			direct: node.isDirect
		}
		if (node.url)
			ret.url = node.url
		return ret
	})

	// console.log('findNode called on us, result:', nodes)

	cb(null, nodes)
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

// calls cb with list of ids
DHT.prototype.findNode = function (id, cb) {
	var self = this

	cb = cb || function (err, res) {
		if (err) {
			console.error('find error:', err)
			return
		}
		console.log('found:', res)
	}

	var closest = Object.keys(self.nodes).map(function (nodeId) {
		return {
			id: nodeId,
			node: self.nodes[nodeId], // either node or origin should be specified
			origin: null,
			startedQuery: false,
			finishedQuery: false,
			direct: self.nodes[nodeId].isDirect
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
		closest.every(function (entry) {
			if (entry.id === self.id)
				return true
			if (!entry.startedQuery) {
				entry.startedQuery = true
				// connect and query
				if(!entry.node) {
					entry.node = self.connect({
						url: entry.url,
						id: entry.id,
						bridge: entry.origin
					})
				}
				entry.node.findNode(id, function (err, closerDescriptors) {
					entry.finishedQuery = true
					if (err) {
						console.error('error querying node:', entry.id)
						return
					}
					// Push results in
					closerDescriptors = closerDescriptors.filter(function (closer) {
						var closerId = closer.id
						return !closest.some(function (entry) {
							return entry.id === closerId
						})
					})
					var toAdd = closerDescriptors.map(function (closer) {
						var closerId = closer.id
						return {
							id: closerId,
							node: null, // Duplicates will have been filtered by now
							origin: entry.node,
							startedQuery: false,
							finishedQuery: false,
							url: closer.url,
							direct: closer.direct
						}
					})
					Array.prototype.push.apply(closest, toAdd)
					organizeClosest()
					makeRequests()
				})
			}
			if (entry.startedQuery && !entry.finishedQuery)
				numInProgress++
			return numInProgress < ALPHA // continue if we can open more connections
		})
		if (numInProgress === 0) {
			var result = closest.map(function (entry) {
				return entry.id
			})
			cb(null, result)
		}
	}
	makeRequests()
}

var id = hat(160)

console.log('my id:', id)

var dht
if (typeof window === 'undefined') {
	dht = new DHT(id, [], 8085)
}
else {
	dht = new DHT(id, ['ws://localhost:8085'])
	window.dht = dht
}


