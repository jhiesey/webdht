var Connector = require('./connector')
var dezalgo = require('dezalgo')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var ConnectionCache = require('./connection-cache')
var rpc = require('rpc-stream')

var Node = function (conn) {
	var self = this

	self.conn = conn
	var rpcStream = selfconn.openStream('rpc', true)

	var api = {
		findNode: function (id, has, cb) {
			self.emit('findNode', id, cb)
		}
	}

	var rpcInstance = new rpc(api)
	self._handle = rpcInstance.wrap(api)
	rpcStream.pipe(rpcInstance).pipe(rpcStream)
}

inherits(Node, EventEmitter)

// Node.prototype.findNode = function (id, cb) {
// 	var self = this
// 	self._handle.findNode(id, has, cb)
// }

var Overlay = module.exports = function (id, wsPort, useWebRTC, bootstrapUrls, has) {
	var self = this
	self.id = id

	self._nodes = {}
	self._connecting = {}
	self._connector = new Connector(id, wsPort, useWebRTC)
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

	var count = opts.closest || 1
	self._findNode(id, {
		exact: count === 1,
		has: opts.has
	}, function (err, nodes) {
		if (err)
			return cb(err)

		nodes = nodes.slice(0, count)
		if (!opts.closest && (!nodes.length || nodes[0].id !== id)) {
			return cb(new Error('node not found'))
		}

		var streams = nodes.map(function (node) {
			if (opts.upgrade)
				node.conn.upgrade()
			return node.conn.openStream('app:' + name, opts.shared)
		})
		cb(null, streams)
	})
})

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

	node.conn('stream', function (name) {
		if (name.slice(0, 4) === 'app:') {
			self.emit('stream', name.slice(4), appStream)
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
		cb(null, true)
	}

	var closest = self._getClosest(id, Object.keys(self._nodes))
	var nodes = closest.map(function (nodeId) {
		var node = self.node[nodeId]
		var ret = {
			id: nodeId,
			url: node.conn.url || null
		}
		return ret
	})

	cb(null, nodes.slice(0, SEARCH_K))
}

function compareXorMetric (id) {
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


var ALPHA = 3

var SEARCH_K = 20

/*
opts.exact
opts.has

*/
// calls cb with list of ids
Overlay.prototype._findNode = function (id, opts, cb) {
	var self = this

	cb = dezalgo(cb)

	var closest = Object.keys(self._nodes).map(function (id) {
		var node = self._connector.nodes[id]
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
					entry.node.conn._handle.findNode(id, opts.has, function (err, closerDescriptors) {
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

				// connect and query
				if(entry.node) {
					findNode()
				} else {
						self.connector.connectTo({
						url: entry.url,
						id: entry.id,
						relay: entry.relay
					}, function (err, conn) {
						if (err)
							removeNode(entry)
						// Need to wait for the 'connection' handler to run
						process.nextTick(function () {
							if (!abort)
								findNode()
						})
					})
				}
			}

			if (!entry.finishedQuery)
				numInProgress++
			return numInProgress < ALPHA // continue if we can open more connections
		})
		if (numInProgress === 0) {
			if (!closest.length)
				return cb(new Error('no more nodes to query'))
			var result = closest.map(function (entry) {
				return entry.node
			})
			cb(null, result)
		}
	}
	makeRequests()
}
