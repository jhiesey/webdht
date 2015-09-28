var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var http = require('http')
var websocket = require('websocket-stream')

var Node = require('./node')
var RoutingTable = require('./routing-table')


var RECONNECT_TIMEOUT = 30
var QUERY_INTERVAL = 5 * 60

var N = 8 // number of nodes to get in one fetch

var Overlay = module.exports = function (id, bootstrapNodes, listenPort) {
	var self = this
	self.id = id
	self.routingTable = new RoutingTable(id)

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

	// Keeps the neighbor list up to date
	// TODO: this won't get enough to fill the neighbor table
	var querySelf = function () {
		self.findNode(id, function (err) {
			setTimeout(querySelf, QUERY_INTERVAL * 1000)
		})
	}

	bootstrapNodes = bootstrapNodes || []
	var bootstrapped = 0
	var connectBootstrap = function (url) {
		var counted = false
		var node = self.connect({
			url: url
		})
		node.on('idSet', function () {
			bootstrapped++
			counted = true
			// Half or more
			if (bootstrapped >= bootstrapNodes.length - bootstrapped)
				querySelf()
		})
		node.on('destroy', function () {
			console.warn('bootstrap node destroyed:', url)
			if (counted)
				bootstrapped--
			setTimeout(connectBootstrap.bind(null, url), RECONNECT_TIMEOUT * 1000)
		})
	}
	bootstrapNodes.forEach(connectBootstrap)
}

inherits(Overlay, EventEmitter)

Overlay.prototype.sendStream = function (id, name, cb) {
	var self = this

	var node = self.routingTable.nodesById[id]
	if (!node) {
		self.findNode(id, function (err, closest) {
			if (err) {
				return cb(err) 
			}
			if (!closest.length || closest[0].id !== id)
				return cb(new Error('Unable to find node with id:', id))
			node = closest[0].node

			node.connectDirect()
			cb(null, node.createAppStream(name))
		})
	} else {
		node.connectDirect()
		cb(null, node.createAppStream(name))
	}
}

Overlay.prototype._attachNode = function (node) {
	var self = this

	node.on('findNode', self._onFindNode.bind(self))

	node.on('connectTo', function (from, id, stream, cb) {
		var to = self.routingTable.nodesById[id]
		if (!to)
			return cb('Unknown node; failed to connect')

		to.connectFrom(from.id, stream, cb)
	})

	node.on('connectFrom', function (from, id, stream, cb) {
		// We already have a node!
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

Overlay.prototype.connect = function (opt) {
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

Overlay.prototype.getClosest = function (id, nodes) {
	nodes = nodes.slice()
	nodes.sort(compareClosestTo(id))

	return nodes.slice(0, N)
}

Overlay.prototype._onFindNode = function (node, id, cb) {
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
Overlay.prototype.findNode = function (id, cb) {
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