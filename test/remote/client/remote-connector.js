
const manifests = require('../manifests')

const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const DuplexPair = require('pull-pair/duplex')
const muxrpc = require('muxrpc')
const wsClient = require('pull-ws/client')
const pull = require('pull-stream')
const once = require('once')
const async = require('async')

const RPC = muxrpc(manifests.connector, manifests.remoteConnector)

// const WebdhtDriverServer = function (config) {
// 	let server = wsServer(function (stream) {
// 		let node = new Node()

// 		pull(stream, node._handle.createStream(), stream)
// 	})

// 	server.listen(config.listenPort)
// }

const noop = function () {}

const RunnerRPC = muxrpc(manifests.server, null)

const RemoteConnectorClient = function (url) {
	if (!(this instanceof RemoteConnectorClient)) return new RemoteConnectorClient(url)
	const self = this

	wsClient(url, {
		binary: true,
		onConnect: function (err, stream) {
			if (err)
				return self.emit('error', err)

			self._stream = stream
			self._handle = RunnerRPC()
			pull(stream, self._handle.createStream(function (err) {
				self.destroy(err)
			}), stream)
			self.emit('ready')
		}
	})
}

module.exports = RemoteConnectorClient
inherits(RemoteConnectorClient, EventEmitter)

RemoteConnectorClient.prototype.getNode = function (type, cb) {
	const self = this

	if (!self._handle)
		return self.once('ready', self.getNode.bind(self, type, cb))

	cb = once(cb)

	let stream = self._handle.getConnector(type, function (err) {
		if (err) cb(err)
	})
	let node = new Node()
	node.on('error', self.emit.bind(self, 'error'))
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

RemoteConnectorClient.prototype.getNodes = function (types, cb) {
	const self = this

	async.parallel(types.map(function (type) {
		return self.getNode.bind(self, type)
	}), cb)
}

RemoteConnectorClient.prototype.getConnectors = function (optses, cb) {
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

RemoteConnectorClient.prototype.destroy = function (err) {
	const self = this
	if (self._destroyed) return

	self._destroyed = true
	self._stream.close()
	self._handle = null
	if (err)
		self.emit('error', err)
}


const Node = function () {
	let self = this

	self._connectors = {}
	self._connectorForConnection = {}

	self._handle = RPC({
		hello: function () {
			self.emit('hello')
		},
		globalerror: function (args) {
			console.log('GLOBAL ERROR')
			self.emit('error', new Error(args.message, args.source, args.lineno))
		},
		onConnection: function (connectorIdNum, idNum, id) {
			// console.log('ON CONNECTION')
			let connector = self._connectors[connectorIdNum]
			connector.emit('connection', connector._setupConn(idNum, id))
		},
		connection: {
			stream: function (idNum, name) {
				// console.log('ON STREAM')
				let connection = self._connectorForConnection[idNum]._connections[idNum]
				let duplex = DuplexPair()
				connection.emit('stream', name, duplex[0])
				return duplex[1]
			},
			close: function (idNum) {
				let connection = self._connectorForConnection[idNum]._connections[idNum]
				connection.emit('close')
				delete self._connectorForConnection[idNum]._connections[idNum]
				delete self._connectorForConnection[idNum].connections[connection.id]
				delete self._connectorForConnection[idNum]
			},
			direct: function (idNum) {
				let connection = self._connectorForConnection[idNum]._connections[idNum]
				connection.emit('direct')
			}
		}
	})
}

inherits(Node, EventEmitter)

Node.prototype.createConnector = function (opts, cb) {
	let self = this

	self._handle.createConnector(opts, function (err, idNum) {
		if (err) return cb(err)
		let connector = new Connector(idNum, opts.id, self._handle, self._connectorForConnection)
		self._connectors[idNum] = connector
		cb(null, connector)
	})
}

const Connector = function (idNum, id, handle, connectorForConnection) {
	let self = this
	self.id = id
	self._idNum = idNum
	self._handle = handle
	self._connections = {}
	self.connections = {}
	self._connectorForConnection = connectorForConnection
}

inherits(Connector, EventEmitter)

Connector.prototype.destroy = function (cb) {
	let self = this
	self._handle.connector.destroy(self._idNum, function (err) {
		if (cb)
			cb(err)
	})
}

Connector.prototype.connectTo = function (descriptor, cb) {
	let self = this
	let d = {
		id: descriptor.id,
		url: descriptor.url,
		relay: descriptor.relay ? descriptor.relay._idNum : null
	}
	self._handle.connector.connectTo(self._idNum, d, function (err, connId) {
		if (err) return cb(err)
		cb(null, self._setupConn(connId))
	})
}

Connector.prototype._setupConn = function (idNum, id) {
	let self = this
	let connection = self._connections[idNum]
	if (!connection) {
		connection = new Connection(idNum, id, self._handle)
		self._connections[idNum] = connection
		self.connections[id] = connection
		self._connectorForConnection[idNum] = self
	}
	return connection
}

const Connection = function (idNum, id, handle) {
	let self = this
	self.id = id
	self._idNum = idNum
	self._handle = handle
}

inherits(Connection, EventEmitter)

Connection.prototype.openStream = function (name, cb) {
	let self = this
	cb = cb || noop
	return self._handle.connector.connection.openStream(self._idNum, name, cb)
}

Connection.prototype.close = function (cb) {
	let self = this
	cb = cb || noop
	self._handle.connector.connection.close(self._idNum, cb)
}

Connection.prototype.upgrade = function (cb) {
	let self = this
	// console.log('CALLING UPGRADE')
	cb = cb || noop
	self._handle.connector.connection.upgrade(self._idNum, cb)
}
