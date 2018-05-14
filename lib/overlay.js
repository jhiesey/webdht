const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const Connector = require('./connector')
const RoutingTable = require('./routing-table')
const PullStreamEnd = require('pull-stream-end/duplex')

/*
FIRST: Connect to bootstrap nodes

TODO:
* Finish routing table
* timeouts
* testing

Later:
* advertise/findAdvertiser
* store data under node id
* encryption/authentication

Unconnected nodes are present in ._nodes but not ._routingTable
*/

// emits 'stream', id, name
let Overlay = module.exports = function (id, wsPort, bootstrapUrls) {
	if (!(this instanceof Overlay)) return new Overlay(id, wsPort, bootstrapUrls)
	const self = this

	self.id = id
	self._ready = false
	self._nodes = {}

	self._connector = new Connector({
		peer: opts.peer,
		id: self.id,
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

	const onConnection = function () {
		node.connection.upgrade()
		self._routingTable.add(node)
	}

	if (node.connection) {
		onConnection()
	} else {	
		node.on('connected', onConnection)
	}
}

// direct if possible by default
Overlay.prototype.openStream = function (id, name, cb) {
	const self = this

	const query = new Query(id, self, true, function (err, nodes) {
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
* { type: 'query', query: Query } // active query; including in closest array NOT SYMMETRIC
* { type: 'routing' } // routing table entry (not supposed to be symmetric)
* { type: 'closerouting' } // in list of nearest K nodes NOT SYMMETRIC
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
	self.idBuf = new Buffer(self.id, 'hex')
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

const Query = function (id, overlay, exact, cb) {
	const self = this

	self.overlay = overlay
	self.id = id
	self.exact = exact
	self.cb = cb
	// closest first array of nodes
	self.closest = self.overlay._routingTable.findNodes(id, K)
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

	// exact termination condition: found relevant node
	if (self.exact && closest[0].id === self.id) {
		return self._onDone(1)
	}

	// termination condition: all closest nodes queried
	for (let i = 0; i < self.closest.length; i++) {
		if (Object.keys(self.querying).length >= ALPHA)
			return

		let node = self.closest[i]
		if (!self.querying[node.id] && !self.queried[node.id]) {
			self._queryNode(node)
		}
	}

	if (Object.keys(self.querying).length === 0)
		self._onDone(self.closest.length)
}

Query.prototype._onDone = function (numResults) {
	const self = this

	self.done = true
	self.cb(null, self.closest.slice(numResults)) // closest will get cleaned up if not saved!
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
			self.closest.sort(RoutingTable.compareXorMetric(self.id))
			const removed = self.closest.splice(K)

			removed.forEach(function (node) {
				node.clearActive('query', self)
			})
		}
		self._makeRequests()
	})
}
