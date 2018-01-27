var duplexify = require('duplexify')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var Overlay = require('./../lib/overlay')
var proxyquire = require('proxyquire')
var rpc = require('rpc-stream')
var stream = require('stream')
var test = require('tape')

var ids = [
	'd8a775cb11dd85f3610b5e686bdd944763e581b2',
	'0d2afaf28eb637eb24b90fc32beaa2a0f06c3b65',
	'2c8ec15aafcda4594fcff163a916204fb11d5832',
	'900e6135b4c4638d7fcb5015fd9b7ec65d390538',
	'0e3a720178da04beece2978d1e5657594432876b',
	'b895d5d12efa8ee75e55d9ca218ed7cc8cafc462',
	'8c1f7571177c1b5758cd691c99f942c8f6fa6f9d',
	'34ee2367d81ba9db2c70cb5591a13b8b2478fd8f',
	'21cd7069d24a7018cf0e5373d9da77578cc6008c',
	'e2d436b8730be3b696e1073028f33ec349287f5a'
]

var myId = ids[0]

var nodes = {}
nodes[myId] = {
	neighbors: []
}
nodes[ids[1]] = {
	neighbors: [
		ids[2],
		ids[3]
	]
}
nodes[ids[2]] = {
	neighbors: [
		ids[4]
	]
}
nodes[ids[3]] = {
	neighbors: [
		ids[5]
	]
}
nodes[ids[4]] = {
	neighbors: [
		ids[6]
	]
}

var urls = {
	'ws://example.com': ids[1]
}

var reportFailure = function (desc) {
	console.error(desc)
	throw new Error(desc)
}

var remoteAppStream = function (id, name, stream) {
	stream.end(JSON.stringify({
		id: id,
		name: name
	}))
}

ConnectionMock = function (id) {
	var self = this
	self.id = id
}

inherits(ConnectionMock, EventEmitter)

ConnectionMock.prototype.openStream = function (name, shared) {
	var self = this
	if (name === 'rpc') {
		// make fake rpc endpoint
		var api = {
			findNode: self._onFindNode.bind(self)
		}
		return new rpc(api)
	} else if (name.slice(0, 4) === 'app:') {
		// app stream
		var stream1 = new stream.PassThrough()
		var stream2 = new stream.PassThrough()
		remoteAppStream(self.id, name.slice(4), duplexify(stream1, stream2))
		return duplexify(stream2, stream1)
	} else {
		reportFailure('unexpected stream name')
	}
}

ConnectionMock.prototype._onFindNode = function (id, has, cb) {
	var self = this

	// just return all neighbors
	var neighbors = nodes[self.id].neighbors
	var descriptors = neighbors.map(function (nodeId) {
		return {
			id: nodeId,
		}
	})
	cb(null, descriptors)
}

ConnectionMock.prototype.upgrade = function () {
	// do nothing for now
}

ConnectorMock = function (id) {
	var self = this

	if (id !== myId)
		throw new Error('connector constructed with invalid id')

	self.connections = {}
	nodes[myId].neighbors.forEach(function (nodeId) {
		self.connections[nodeId] = new ConnectionMock(nodeId)
	})
}

inherits(ConnectorMock, EventEmitter)

ConnectorMock.prototype.connectTo = function (descriptor, cb) {
	var self = this

	var newConn = false
	var id = descriptor.id
	if (descriptor.url) {
		id = urls[descriptor.url]
		if (!id)
			return reportFailure('invalid url')
	}
	if (!self.connections[id]) {
		if (!descriptor.url) {
			var nodeInfo = nodes[descriptor.relay.id]
			if (!nodeInfo && nodeInfo.neighbors.indexOf(id) < 0) {
				return reportFailure('cannot connect to that node')
			}
		}
		newConn = true
		self.connections[id] = new ConnectionMock(id)
	}

	process.nextTick(function () {
		cb(null, self.connections[id])
		if (newConn)
			self.emit('connection', self.connections[id])
	})
}

var Overlay = proxyquire('./../lib/overlay', {
	'./connector': ConnectorMock
})

function extractJsonStream (stream, cb) {
	var buffers = []
	stream.on('data', function (buffer) {
		buffers.push(buffer)
	})
	stream.on('end', function () {
		var obj
		try {
			obj = JSON.parse(Buffer.concat(buffers).toString())
		} catch (err) {
			return cb(err)
		}
		cb(null, obj)
	})
	stream.on('error', function (err) {
		cb(err)
	})
}

/*
opts.has
opts.closest = number
opts.shared
opts.upgrade

If closest is specified, the results are limited to this many. Otherwise exact match only.
If has is specified, search ends early when 'has' found
*/
//Overlay.prototype.openStream = function (id, name, opts, cb)

test('Query bootstrap node', function (t) {
	var overlay = new Overlay(myId, null, ['ws://example.com'])

	overlay.on('ready', function () {
		overlay.openStream(ids[1], 'one', {}, function (err, streams) {
			t.notOk(err, 'bootstrap node lookup')
			t.equal(streams.length, 1, 'correct number of streams')
			extractJsonStream(streams[0], function (err, obj) {
				t.notOk(err, 'valid stream data')
				t.equal(obj.id, ids[1], 'id correct')
				t.equal(obj.name, 'one', 'name correct')
				t.end()
			})
		})
	})
})

test('Query bootstrap node neighbor', function (t) {
	var overlay = new Overlay(myId, null, ['ws://example.com'])

	overlay.on('ready', function () {
		overlay.openStream(ids[2], 'one', {}, function (err, streams) {
			t.notOk(err, 'two away lookup')
			t.equal(streams.length, 1, 'correct number of streams')
			extractJsonStream(streams[0], function (err, obj) {
				t.notOk(err, 'valid stream data')
				t.equal(obj.id, ids[2], 'id correct')
				t.equal(obj.name, 'one', 'name correct')
				t.end()
			})
		})
	})
})

test('Query through long chain', function (t) {
	var overlay = new Overlay(myId, null, ['ws://example.com'])

	overlay.on('ready', function () {
		overlay.openStream(ids[6], 'one', {}, function (err, streams) {
			t.notOk(err, 'five away lookup')
			t.equal(streams.length, 1, 'correct number of streams')
			extractJsonStream(streams[0], function (err, obj) {
				t.notOk(err, 'valid stream data')
				t.equal(obj.id, ids[6], 'id correct')
				t.equal(obj.name, 'one', 'name correct')
				t.end()
			})
		})
	})
})

test('Query unreachable', function (t) {
	var overlay = new Overlay(myId, null, ['ws://example.com'])

	overlay.on('ready', function () {
		overlay.openStream(ids[9], 'one', {}, function (err, streams) {
			t.ok(err, 'unreachable lookup')
			t.end()
		})
	})
})
