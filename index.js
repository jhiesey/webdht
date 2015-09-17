
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var http = require('http')
var inherits = require('inherits')
var once = require('once')
var rpc = require('rpc-stream')
var SimplePeer = require('simple-peer')
var SimpleWebsocket = require('simple-websocket')
var websocket = require('websocket-stream')
var SwitchableStream = require('./switchable-stream')
var multiplex = require('multiplex')
var pump = require('pump')

/*
TODO list:
CHECK handle both sides trying to connect
CHECK handle both sides trying to switch to direct
CHECK proper routing table
CHECK ref counting
CHECK handle disconnects (all structure except self._allNodes is transient)
CHECK Nesting depth? at any rate, some way to decide when to connect directly
CHECK Counting in-progress requests


Better interface: create a node store!




limit number of real connections in a bucket (2?)
	OR: limit total size of routing table pool. size per bucket changes dynamically
limit number of total connections in a bucket (10?)
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

var NEIGHBOR_POOL_SIZE = 20

var ID_BITS = 160

var RoutingTable = function (myId) {
	var self = this
	self.myId = myId

	self.nodesById = {} // id -> node

	// NOT used for routing:
	// copied to nodesById when id is set
	self.nodesByUrl = {} // url -> node
	// moved to nodesById when id is set
	self.extraNodes = [] // list of node objects where neither url nor id is known

	self._neighbors = []
}

RoutingTable.prototype.add = function (node) {
	var self = this

	node.on('destroy', self._remove.bind(self, node))

	if (node.url) {
		self.nodesByUrl[node.url] = node
	}

	if (node.id) {
		self._onIdKnown(node)
	} else {
		if (!node.url)
			self.extraNodes.push(node)

		node.on('idSet', function () {
			var idx = self.extraNodes.indexOf(node)
			if (idx >= 0)
				self.extraNodes.splice(idx, 1)
			self._onIdKnown(node)
		})
	}
}

var MAX_CONNECTIONS = 200

var BUCKET_SIZE = 5

// actually add and do all the important stuff
RoutingTable.prototype._onIdKnown = function (node) {
	var self = this

	console.log('connected to node:', node.id)
	self.nodesById[node.id] = node

	// compute full table
	var ids = Object.keys(self.nodesById)
	if (ids.length <= MAX_CONNECTIONS)
		return

	ids.sort(compareClosestTo(self.myId))
	var neighbors = ids.slice(0, NEIGHBOR_POOL_SIZE)
	self._neighbors.forEach(function (id) {
		self.nodesById[id].active.neighbor = false
	})
	self._neigbors = neighbors
	self._neighbors.forEach(function (id) {
		self.nodesById[id].active.neighbor = true
	})

	var myBits = new Bitfield(new Buffer(self.myId, 'hex'))
	// index 0 has highest bit different
	var buckets = []
	for (var bit = 0; bit < ID_BITS; bit++) {
		if (!ids.length)
			break
		buckets.push([])
		// check if the current bucket needs splitting
		var shouldSplit = ids.length > BUCKET_SIZE
		while(true) {
			var id = ids.pop()
			// check if this bit is different
			var idBits = new Bitfield(new Buffer(id, 'hex'))
			if (idBits.get(bit) === myBits.get(bit) && shouldSplit) {
				ids.push(id)
				break
			}

			buckets[bit].push(id)
		}
		if (!shouldSplit)
			break
	}

	do {
		// sort largest to smallest
		buckets.sort(function (left, right) {
			return right.length - left.length
		})

		var removed = buckets.some(function (bucket) {
			return bucket.some(function (id) {
				var active = self.nodesById[id].isActive
				// TODO: better policy than first found
				if (!active)
					self.nodesById[id].destroy()
				return !active
			})
		})
	} while (removed && ids.length > MAX_CONNECTIONS)
}

RoutingTable.prototype._remove = function (node) {
	var self = this

	if (node.url)
		delete self.nodesByUrl[node.url]
	if (node.id)
		delete self.nodesById[node.id]

	var idx = self.extraNodes.indexOf(node)
	if (idx >= 0)
		self.extraNodes.splice(idx, 1)
}

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

var Node = function (opt, myId) {
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
	self._conn = new SwitchableStream(stream)
	self._mux = multiplex({
		chunked: true
	}, function (appStream, name) {
		if (name.slice(0, 4) === 'app:') {
			var emitStream = function () {
				self.emit('appStream', self.id, appStream, name.slice(4))
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

	self._conn.on('close', self.destroy.bind(self))
	self._conn.on('error', self.emit.bind(self, 'error'))

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
Node.prototype.destroy = function () {
	var self = this
	if (self._destroyed)
		return

	self._destroyed = true
	self._conn.destroy()
	self.emit('destroy')
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
	self._conn.replace(newStream)
}

Node.prototype._setupDirectConn = function (initiator) {
	var self = this

	// This handles cleaning up if we're replacing another direct connection
	if (self._directConn)
		self._directConn.removeListener('connect', emitDirect)

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
	self._directConn.on('connect', self.emit.bind(self, 'direct'))
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
	// stream.on('open', function () {
	// 	console.log('substream open')
	// })
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
		if (err) {
			unref()
			console.error('error in connectFrom:', err)
		}
	})
	self._handle.connectFrom(id, cb)
}

var N = 8 // number of nodes to get in one fetch

var DHT = function (id, bootstrapNodes, listenPort) {
	var self = this
	self.id = id
	self.routingTable = new RoutingTable(id)
	// self.nodes = {}

	// self.nodesByUrl = {}

	if (listenPort) {
		var server = http.createServer()
		var wss = websocket.createServer({
			server: server
		}, function (stream) {
			self.connect({
				connection: stream,
			})
		})
		server.listen(listenPort)
	}

	bootstrapNodes = bootstrapNodes || []
	var bootstrapped = 0
	bootstrapNodes.forEach(function (url) {
		var node = self.connect({
			url: url
		})
		node.on('idSet', function () {
			bootstrapped++
			// Half or more
			if (bootstrapped >= bootstrapNodes.length - bootstrapped)
				// TODO: this won't get enough to fill the neighbor table
				self.findNode(id)
		})
	})
}

DHT.prototype.sendStream = function (id, name, cb) {
	var self = this

	var node = self._allNodes[id] 
	if (!node) {
		self.findNode(id, function (err, closest) {
			if (err) {
				return cb(err) 
			}
			if (!closest.length || closest[0].node.id !== id)
				return cb(new Error('Unable to find node with id:', id))
			node = closest[0].node

			node.connectDirect()
			cb(null, node.createAppStream(name))
		})
	}
}

DHT.prototype._attachNode = function (node) {
	var self = this

	node.on('findNode', self.onFindNode.bind(self))

	node.on('connectTo', function (from, id, stream, cb) {
		// console.log('got connectTo')
		// stream.on('data', function (buf) {
		// 	console.log(buf.toString())
		// })
		var to = self.routingTable.nodesById[id]
		if (!to)
			return cb('Unknown node; failed to connect')

		to.connectFrom(from.id, stream, cb)
	})

	node.on('connectFrom', function (from, id, stream, cb) {
		// We already have a node!
		// console.log('got connectFrom')
		// stream.on('data', function (buf) {
		// 	console.log(buf.toString())
		// })
		var existingNode = self.routingTable.nodesById[id]
		if (existingNode) {
			// Ignore if our id is higher than theirs (our outgoing connection will win)
			if ((new Buffer(id, 'hex')).compare(new Buffer(self.id, 'hex')) < 0)
				return cb(null, false)

			// Replace if our id is lower than theirs (our outgoing connection will fail)
			existingNode.replaceStream(stream)
			return cb(null, true)
		}

		self.connect({
			id: id,
			connection: stream,
			relay: node
		})
		cb(null, true)
	})

	node.on('appStream', function (id, name, appStream) {
		self.emit('stream', id, name, appStream)
	})
}

/*
REAL descriptor (over the wire): {
	url: 'wss://foo.bar',
	id: '1234abcd'
}

*/

DHT.prototype.connect = function (opt) {
	var self = this

	var node = new Node(opt, self.id)

	self._attachNode(node)
	self.routingTable.add(node)

	return node
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

	var closest = self.getClosest(id, Object.keys(self.routingTable.nodesById))

	var nodes = closest.map(function (nodeId) {
		var node = self.routingTable.nodesById[nodeId]
		var ret = {
			id: nodeId,
			url: node.url || null
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

	var closest = Object.keys(self.routingTable.nodesById).map(function (nodeId) {
		var node = self.routingTable.nodesById[nodeId]
		// node.ref()
		return {
			id: nodeId,
			node: node, // either node or relay should be specified
			relay: null,
			startedQuery: false,
			finishedQuery: false
		}
	})
	// insert ourself
	closest.push({
		id: self.id,
		node: { // fake self node
			id: self.id
		},
		relay: null,
		startedQuery: true,
		finishedQuery: true
	})

	if (closest.length === 0)
		return cb(new Error('no nodes in routing table'))

	var comparator = compareClosestTo(id)

	function organizeClosest() {
		closest.sort(function (left, right) {
			return comparator(left.id, right.id)
		})
		var removed = closest.slice(SEARCH_K)
		removed.forEach(function (entry) {
			if (entry.node)
				entry.node.unref()
		})
		closest = closest.slice(0, SEARCH_K)
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
						relay: entry.relay
					})
				}
				entry.node.findNode(id, function (err, closerDescriptors) {
					entry.finishedQuery = true
					if (err) {
						console.error('error querying node:', entry.id)
						// remove failed node
						var idx = closest.indexOf(entry)
						if (idx >= 0)
							closest.splice(idx, 1)
						makeRequests()
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
							relay: entry.node,
							startedQuery: false,
							finishedQuery: false,
							url: closer.url
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
				return entry.node
			})
			cb(null, result)
		}
	}
	makeRequests()
}

var id = hat(ID_BITS)

console.log('my id:', id)

var dht
if (typeof window === 'undefined') {
	dht = new DHT(id, [], 8085)
}
else {
	dht = new DHT(id, ['ws://localhost:8085'])
	window.dht = dht
}
