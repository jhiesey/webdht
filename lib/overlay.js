const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const Connector = require('./connector')
const RoutingTable = require('./routing-table')

/*
FIRST: Connect to bootstrap nodes

Unconnected nodes are present in ._nodes but not ._routingTable
*/

function compareXorMetric (id) {
	var idBuf = new Buffer(id, 'hex')

	return function (left, right) {
		var leftBuf = new Buffer(left, 'hex')
		var rightBuf = new Buffer(right, 'hex')
		for (var i = 0; i < 20; i++) {
			var byteXorDelta = (leftBuf[i] ^ idBuf[i]) - (rightBuf[i] ^ idBuf[i])
			if (byteXorDelta)
				return byteXorDelta
		}
		return 0	
	}
}

// emits 'stream', id, name
let Overlay = module.exports = function (id, wsPort, bootstrapUrls) {
	if (!(this instanceof Overlay)) return new Overlay(id, wsPort, bootstrapUrls)
	const self = this

	self._id = id
	self._idBuf = new Buffer(id, 'hex')
	self._ready = false
	self._nodes = {}

	self._connector = new Connector({
		peer: opts.peer,
		id: id,
		wsPort: wsPort
	})

	self._routingTable = new RoutingTable(id)
	self._connector.on('connection', function (conn) {
		if (self._nodes[conn.id])
			return

		self._addNode(new Node({id: conn.id}, self, conn))
	})

	self._bootstrap(bootstrapUrls)
}

inherits(Overlay, EventEmitter)

Overlay.prototype._addNode = function (node) {
	const self = this

	self._nodes[node.id] = node
	node.on('destroy', function () {
		delete self._nodes[conn.id]
	})
	node.on('stream', function (name, stream) {
		self.emit('stream', node.id, name, stream)
	})
	if (node.connection) {
		self._routingTable.add(node)
	} else {	
		node.on('connected', function () {
			self._routingTable.add(node)
		})
	}
}

// direct if possible by default
Overlay.prototype.openStream = function (id, name, cb) {
	const self = this

	const query = new Query(id, self, function (err, nodes) {
		if (err)
			return cb(err)
		if (nodes[0].id !== id) {
			return cb(new Error('node not found'))
		}

		const node = nodes[0]
		node.openStream(name, cb)
	})
}

// advertise hash
// find id's that advertise hash

// store value
// get value

Overlay.prototype._bootstrap = function (urls) {
	const self = this

	let needed = Math.max(1, Math.floor(urls.length / 2))
	let successes = 0
	let errors = 0
	let done = false

	// open all connections
	// once the greater of 1 node or half of urls are connected, emit 'ready'
	urls.forEach(function (url) {
		self._connector.connectTo({ url: url }, function (err, conn) {
			if (err) {
				console.error('bootstrap error:', err)
				errors++
			} else {
				successes++
			}
			if (!done) {
				if (successes >= needed) {
					done = true
					self._ready = true
					self.emit('ready')
				} else if (urls.length - errors < needed) {
					done = true
					self.emit('error', err)
				}
			}
		})
	})
}

const manifest = {
	findNode: 'sync',
	// release: 'sync', // findNode connections no longer needed
	// neededChange: 'sync'
}

const RPC = muxrpc(manifest, manifest)

// wraps a connection and does refcounting stuff
/*
NEEDS:
* connection

* active array/object (basically refcount+debug info)
- query (rpc in progress)
- relay (relay for node in closest array)
- stream (application stream open)
- routing (kept alive for routing) <- treated differently?
- forwarding (another connection runs over this)

Wait, what about a relay holding connections to its neighbors open on behalf
of a requester?

maybe we should have a master node list in the overlay object and
only use ids here?

Can a node exist without a connection?
Or is that a different object?

_active types:
* { type: 'query', query: Query } // active query; including in closest array
* { type: 'routing' } // routing table entry
* { type: 'closerouting' } // in list of nearest K nodes
* { type: 'relay', id: id } // forwarding connection to id
* { type: 'stream', stream: duplex pull stream } // app stream

TODO: make 'routing', 'closerouting', and 'forwarding' work.

'forwarding' is our job!
Two cases:
* 'end' forwarding
* 'middle' forwarding


*/

// support non-connected state? YES
const Node = function (descriptor, overlay, connection) {
	const self = this
	self.descriptor = descriptor
	self.id = descriptor.id
	self._overlay = overlay
	self._active = [] // reasons the connection is kept open
	self._connecting = false

	if (connection)
		self._connected(connection)
}

inherits(Node, EventEmitter)

Node.prototype._connect = function (cb) {
	const self = this

	if (self._connecting) {
		return self.on('connected', cb)
	}
	self._connecting = true

	self._overlay._connector.connectTo(self.descriptor, function (err, conn) {
		if (err)
			return cb(err)

		self._connecting = false
		self._connected(conn)
	})
}

Node.prototype._connected = function (connection) {
	const self = this

	self.connection = connection
	self._handle = RPC({
		findNode: function (id) {
			const nodes = self._overlay._routingTable.findNode(id)
			return nodes.map(function (node) {
				return node.descriptor
			})
		}
	})

	let s = self._handle.createStream(function (err) {
		self.destroy(err)
	})

	if (self.connection.initiator) {
		// open on dialing end
		let rpcStream = self.connnection.openStream('rpc')
		pull(rpcStream, s, rpcStream)
	}

	self.connection.on('stream', function (name, stream) {
		// wait on dialed end
		if (name === 'rpc' && !self.connection.initiator) {
			pull(stream, s, stream)
		} else if (name.slice(0, 4) === 'app:') {
			const endPair = PullStreamEnd(function (err) {
				self.clearActive('stream', endPair[0])
			})
			pull(stream, endPair[1], stream)
			self.setActive('stream', endPair[0])
			self.emit('stream', name.slice(4), endPair[0])
		} else {
			console.error('unexpected incoming stream:', name)
		}
	})

	self.connection.on('relay', function (id) {
		self.setActive('relay', id)
	})
	self.connection.on('relay-end', function (id) {
		self.clearActive('relay', id)
	})

	self.emit('connected')
}

Node.prototype.setActive = function (type, ref) {
	const self = this

	let entry = {
		type: type
	}
	switch (type) {
		case 'query':
			entry.query = ref
			break
		case 'routing':
		case 'closerouting':
			break
		case 'relay':
			entry.id = ref
			break
		case 'stream'
			entry.stream = ref
			break
		default:
			throw new Error('unknown active type')
	}
	self._active.push(entry)
}

Node.prototype.clearActive = function (type, ref) {
	const self = this

	self._active = self._active.filter(function (entry) {
		if (entry.type !== type)
			return true
		switch (type) {
			case 'query':
				return entry.query !== ref
			case 'routing':
			case 'closerouting':
				return false
			case 'relay':
				return entry.id !== ref
			case 'stream':
				return entry.stream !== ref
			default:
				throw new Error('unknown active type')
		}
	})
	if (self._active.length === 0) {
		self.destroy()
	}
}

Node.prototype.destroy = function (err) {
	const self = this

	if (self._destroyed)
		return
	self._destroyed = true

	self.connection.destroy(err)

	self.emit('destroy', err)
}

Node.prototype.findNode = function (id, cb) {
	const self = this

	if (!self.connection) {
		return self._connect(function (err) {
			if (err)
				return cb(err)
			self.findNode(id, cb)
		})
	}

	self._handle.findNode(id, function (err, descriptors) {
		if (err)
			return cb(err)

		const nodes = descriptors.map(function (descriptor) {
			if (self._overlay._nodes[descriptor.id])
				return self._overlay._nodes[descriptor.id]

			// Nodes start out with ._active empty; it should be set
			// asap
			const node = new Node(descriptor, self._overlay)
			self._overlay._addNode(node)
			return node
		})
		cb(null, nodes)
	})
}

Node.prototype.openStream = function (id, name, cb) {
	const self = this

	if (!self.connection) {
		return self._connect(function (err) {
			if (err)
				return cb(err)
			self.openStream(id, cb)
		})
	}

	const stream = self.connection.openStream('app:' + name, function (err) {
		self.clearActive('stream', stream)
	})
	self.setActive('stream', stream)
	cb(null, stream)
}

const ALPHA = 3
const K = 20
const QUERY_TIMEOUT = 10 // seconds

const Query = function (id, overlay, cb) {
	const self = this

	self.overlay = overlay
	self.id = id
	self.cb = cb
	// closest first array of nodes
	self.closest = self.overlay._routingTable.findNode(id)
	self.closest.forEach(function (node) {
		node.setActive('query', self)
	})
	self.querying = {}
	self.queried = {}
	self.done = false

	self._makeRequests()
}

Query.prototype._makeRequests = function () {
	const self = this

	if (self.done)
		return
	self.done = true

	for (let i = 0; i < self.closest.length; i++) {
		if (Object.keys(self.querying).length >= ALPHA)
			return

		let node = self.closest[i]
		if (!self.querying[node.id] && !self.queried[node.id]) {
			self._queryNode(node)
		}
	}

	if (Object.keys(self.querying).length > 0)
		return

	self.cb(null, self.closest) // closest will get cleaned up if not saved!
	self.closest.forEach(function (node) {
		node.clearActive('query', self)
	})
}

// descriptor has url and id
// need to keep alive relays that we will use later, so increment refcount!
// TODO: timeout
Query.prototype._queryNode = function (node) {
	const self = this

	self.querying[node.id] = true
	node.on('destroy', function () {
		delete self.querying[node.id]
	})
	node.findNode(self.id, function (err, nodes) {
		delete self.querying[node.id]
		self.queried[node.id] = true
		if (err) {
			console.error('query error:', err)
		} else {
			nodes.forEach(function (node) {
				node.setActive('query', self) // for nodes added to closest
				node.on('destroy', function () {
					let nodeIdx = self.closest.find(node)
					if (nodeIdx >= 0)
						self.closest.splice(nodeIdx, 1)
				})
			})

			self.closest.push.apply(self.closest, nodes)
			self.closest.sort(compareXorMetric(self.id))
			const removed = self.closest.splice(K)

			removed.forEach(function (node) {
				node.clearActive('query', self)
			})
		}
		self._makeRequests()
	})
}

var async = require('async')
var Connector = require('./connector')
var dezalgo = require('dezalgo')
var duplexify = require('duplexify')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var ConnectionCache = require('./connection-cache')
var rpc = require('rpc-stream')
var stream = require('stream')

var Node = function (conn) {
	var self = this

	self.conn = conn
	var rpcStream = self.conn.openStream('rpc', true)

	var api = {
		findNode: function (id, has, cb) {
			self.emit('findNode', id, has, cb)
		}
	}

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)
	rpcStream.pipe(rpcInstance).pipe(rpcStream)
}

inherits(Node, EventEmitter)

var Overlay = module.exports = function (id, wsPort, bootstrapUrls, has) {
	var self = this
	self.id = id

	self._nodes = {}
	self._connector = new Connector(id, wsPort)
	self._has = has

	self._connectionCache = new ConnectionCache(self._connector, bootstrapUrls)
	self._connectionCache.on('ready', self.emit.bind(self, 'ready'))

	Object.defineProperty(self, 'ready', {
		get: function () {
			return self._connectionCache.ready
		}
	})

	self._connector.on('connection', function (conn) {
		self._connectionCache.add(conn)
		self._addNode(conn)
	})
}

inherits(Overlay, EventEmitter)

// Connects to exact node
/*
opts.has
opts.closest = number
opts.shared
opts.upgrade

If closest is specified, the results are limited to this many. Otherwise exact match only.
If has is specified, search ends early when 'has' found
*/
Overlay.prototype.openStream = function (id, name, opts, cb) {
	var self = this

	opts = opts || {}
	var count = opts.closest || 1
	self._findNode(id, {
		exact: count === 1,
		has: opts.has
	}, function (err, entries) {
		if (err)
			return cb(err)

		entries = entries.slice(0, count)
		if (!opts.closest && (!entries.length || entries[0].id !== id)) {
			return cb(new Error('node not found'))
		}

		async.map(entries, function (entry, done) {
			if (entry.id === self.id) {
				var stream1 = new stream.PassThrough()
				var stream2 = new stream.PassThrough()
				self.emit('stream', self.id, name, duplexify(stream1, stream2))
				return duplexify(stream2, stream1)
			}
			// connect and query
			self._ensureConnection(entry, function (err) {
				if (err)
					return done(err)

				var node = entry.node

				if (opts.upgrade)
					node.conn.upgrade()
				done(null, node.conn.openStream('app:' + name, opts.shared))
			})
		}, cb)
	})
}

/*
for a dht, we need to be able to:
* (check) find an exact node
* (check) find closest nodes
* find nodes that have something



*/

Overlay.prototype._addNode = function (conn) {
	var self = this

	var node = self._nodes[conn.id] = new Node(conn)

	conn.on('close', function () {
		delete self._nodes[conn.id]
	})

	node.on('findNode', self._onFindNode.bind(self))

	node.conn.on('stream', function (name, appStream) {
		if (name.slice(0, 4) === 'app:') {
			self.emit('stream', conn.id, name.slice(4), appStream)
		}
	})
}

Overlay.prototype._getClosestN = function (id, nodes, n) {
	nodes = nodes.slice()
	nodes.sort(compareXorMetric(id))
	return nodes.slice(0, n)
}

Overlay.prototype._getHas = function (id) {
	var self = this
	if (typeof self._has === 'function')
		return self._has(id)
	else if (typeof self._has === 'object')
		return id in self._has
	else
		return false
}

Overlay.prototype._onFindNode = function (id, has, cb) {
	var self = this

	if (has && self._getHas(id)) {
		return cb(null, true)
	}

	var closest = self._getClosestN(id, Object.keys(self._nodes), SEARCH_K)
	var nodes = closest.map(function (nodeId) {
		var node = self.node[nodeId]
		return {
			id: nodeId,
			url: node.conn.url || null
		}
	})

	cb(null, nodes)
}

function compareXorMetric (id) {
	var idBuf = new Buffer(id, 'hex')

	return function (left, right) {
		var leftBuf = new Buffer(left, 'hex')
		var rightBuf = new Buffer(right, 'hex')
		for (var i = 0; i < 20; i++) {
			var byteXorDelta = (leftBuf[i] ^ idBuf[i]) - (rightBuf[i] ^ idBuf[i])
			if (byteXorDelta)
				return byteXorDelta
		}
		return 0	
	}
}


var ALPHA = 3

var SEARCH_K = 20

Overlay.prototype._ensureConnection = function (entry, cb) {
	var self = this
	cb = dezalgo(cb)

	if (entry.node) {
		return cb(null)
	}

	self._connector.connectTo({
		url: entry.url,
		id: entry.id,
		relay: entry.relay
	}, function (err, conn) {
		// Need to wait for the 'connection' handler to run
		process.nextTick(function () {
			entry.node = self._nodes[entry.id]
			cb(err)
		})
	})
}

/*
opts.exact
opts.has

entries:
* id
* node
* relay
* startedQuery
* finishedQuery

*/
// calls cb with list of ids
Overlay.prototype._findNode = function (id, opts, realCb) {
	var self = this

	var cb = dezalgo(function (err, entries) {
		if (err)
			return realCb(err)

		if (opts.exact) {
			entries = entries.slice(0, 1)
			if (entries[0].id !== id)
				entries = []
		}

		realCb(null, entries)
	})

	var closest = Object.keys(self._nodes).map(function (id) {
		var node = self._nodes[id]
		return {
			id: id,
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

	var comparator = compareXorMetric(id)

	function organizeClosest() {
		closest.sort(function (left, right) {
			return comparator(left.id, right.id)
		})
		closest = closest.slice(0, SEARCH_K)
	}
	organizeClosest()

	var abort = false
	function makeRequests () {
		if (opts.exact && closest[0].id === id) {
			abort = true
			return cb(null, closest)
		} else if (abort) {
			return
		}

		var numInProgress = 0
		closest.every(function (entry) {
			if (entry.id === self.id)
				return true
			if (!entry.startedQuery) {
				entry.startedQuery = true

				function removeNode () {
					// console.error('error querying to node:', entry.id, err)
					// remove failed node
					var idx = closest.indexOf(entry)
					if (idx >= 0)
						closest.splice(idx, 1)
					entry.finishedQuery = true
					makeRequests()
				}

				function findNode () {
					entry.node._handle.findNode(id, opts.has, function (err, closerDescriptors) {
						entry.finishedQuery = true
						if (err) {
							removeNode()
							return
						}
						if (opts.has && closerDescriptors === true) {
							abort = true
							return cb(null, [entry])
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
								relay: entry.node.conn,
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

				// connect and query
				self._ensureConnection(entry, function (err) {
					if (err)
						removeNode(entry)
						process.nextTick(function () {
							if (!abort)
								findNode()
						})
				})
			}

			if (!entry.finishedQuery)
				numInProgress++
			return numInProgress < ALPHA // continue if we can open more connections
		})
		if (numInProgress === 0) {
			if (!closest.length)
				return cb(new Error('no more nodes to query'))
			cb(null, closest)
		}
	}
	makeRequests()
}
