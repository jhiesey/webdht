var NEIGHBOR_POOL_SIZE = 20

var ID_BITS = 160

let RoutingTable = module.exports = function (myId) {
	const self = this
	self.id = myId

	self.nodes = {}
}

RoutingTable.prototype.add = function (node) {
	const self = this
	self._nodes[node.id] = node

	node.on('destroy', function () {
		delete self._nodes[node.id]
	})
}

RoutingTable.prototype.findNodes = function (id, count) {
	const self = this

	let closest = Object.values(self._nodes)
	closest.sort(exports.compareXorMetric(id))
	return closest.slice(0, count)
}

exports.compareXorMetric = function (id) {
	var idBuf = new Buffer(id, 'hex')

	return function (left, right) {
		var leftBuf = left.idBuf
		var rightBuf = right.idBuf
		for (var i = 0; i < leftBuf.length; i++) {
			var byteXorDelta = (leftBuf[i] ^ idBuf[i]) - (rightBuf[i] ^ idBuf[i])
			if (byteXorDelta)
				return byteXorDelta
		}
		return 0
	}
}

/*
var RoutingTable = module.exports = function (myId) {
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
*/
