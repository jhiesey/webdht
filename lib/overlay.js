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
