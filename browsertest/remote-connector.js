
const manifests = require('./manifests')

const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const DuplexPair = require('pull-pair/duplex')
const muxrpc = require('muxrpc')
const wsClient = require('pull-ws/client')
const pull = require('pull-stream')
const once = require('once')
const async = require('async')

const RPC = muxrpc(manifests.client, manifests.server)

// const WebdhtDriverServer = function (config) {
// 	let server = wsServer(function (stream) {
// 		let node = new Node()

// 		pull(stream, node._handle.createStream(), stream)
// 	})

// 	server.listen(config.listenPort)
// }

const RunnerRPC = muxrpc({
	subject: 'duplex',
	getSubject: 'duplex'
}, null)

const TestClient = function (url) {
	if (!(this instanceof TestClient)) return new TestClient(url)
	const self = this

	wsClient(url, {
		binary: true,
		onConnect: function (err, stream) {
			if (err)
				return self.emit('error', err)

			self._handle = RunnerRPC()
			pull(stream, self._handle.createStream(function (err) {
				self._destroy(err)
			}), stream)
			self.emit('ready')
		}
	})
}

module.exports = TestClient
inherits(TestClient, EventEmitter)

TestClient.prototype.getNode = function (type, cb) {
	const self = this

	if (!self._handle)
		return self.once('ready', self.getNode.bind(self, type, cb))

	cb = once(cb)

	let stream = self._handle.getSubject(type, function (err) {
		if (err) cb(err)
	})
	let node = new Node() // TODO: list of nodes?
	pull(stream, node._handle.createStream(function (err) {
		if (err)
			cb(err)
		else
			node.emit('disconnect')
	}), stream)
	node.once('hello', function () {
		cb(null, node)
	})
}

TestClient.prototype.getNodes = function (types, cb) {
	const self = this

	async.parallel(types.map(function (type) {
		return self.getNode.bind(self, type)
	}), cb)
}

TestClient.prototype.getConnectors = function (optses, cb) {
	const self = this

	async.parallel(optses.map(function (opts) {
		return function (callback) {
			let type
			if (opts.wsPort)
				type = 'node'
			else
				type = 'any'
			self.getNode(type, function (err, node) {
				if (err) return callback(err)
				node.createConnector(opts, callback)
			})
		}
	}), cb)
}

TestClient.prototype._destroy = function (err) {
	const self = this
	if (self._destroyed) return

	self._destroyed = true
	self._handle = null
	if (err)
		self.emit('error', err)
}


const Node = function () {
	let self = this

	self.connectors = {}
	self._connectorForConnection = {}

	self._handle = RPC({
		hello: function () {
			self.emit('hello')
		},
		onConnection: function (connectorId, id) {
			let connector = self.connector[connectorId]
			connector.emit('connection', connector._setupConn(id))
		},
		connection: {
			stream: function (id, name) {
				let connection = self._connectorForConnection[id].connections[id]
				let duplex = DuplexPair()
				connection.emit('stream', name, duplex[0])
				return duplex[1]
			},
			close: function (id) {
				let connection = self._connectorForConnection[id].connections[id]
				connection.emit('close')
				delete self._connectorForConnection[id].connections[id]
				delete self._connectorForConnection[id]
			},
			direct: function (id) {
				let connection = self._connectorForConnection[id].connections[id]
				connection.emit('direct')
			}
		}
	})
}

inherits(Node, EventEmitter)

Node.prototype.createConnector = function (opts, cb) {
	let self = this

	self._handle.createConnector(opts, function (err, id) {
		if (err) return cb(err)
		let connector = new Connector(id, self._handle, self._connectorForConnection)
		self.connectors[id] = connector
		cb(null, connector)
	})
}

const Connector = function (id, handle, connectorForConnection) {
	let self = this
	self.id = id
	self._handle = handle
	self.connections = {}
	self._connectorForConnection = connectorForConnection
}

inherits(Connector, EventEmitter)

Connector.prototype.destroy = function (cb) {
	let self = this
	self._handle.connector.destroy(self.id, function (err) {
		cb(err)
	})
}

Connector.prototype.connectTo = function (descriptor, cb) {
	let self = this
	self._handle.connector.connectTo(self.id, descriptor, function (err, connId) {
		if (err) return cb(err)
		cb(null, self._setupConn(connId))
	})
}

Connector.prototype._setupConn = function (id) {
	let self = this
	let connection = self.connections[id]
	if (!connection) {
		connection = new Connection(id, self._handle)
		self.connections[id] = connection
		self._connectorForConnection[id] = self
	}
	return connection
}

const Connection = function (id, handle) {
	let self = this
	self.id = id
	self._handle = handle
}

inherits(Connection, EventEmitter)

Connection.prototype.openStream = function (name, cb) {
	let self = this
	return self._handle.connector.connection.openStream(self.id, name)
}

Connection.prototype.close = function (cb) {
	let self = this
	self._handle.connector.connection.close(self.id, cb)
}

Connection.prototype.upgrade = function (cb) {
	let self = this
	self._handle.connector.connection.upgrade(self.id, cb)
}
