const Connector = require('../lib/connector')
const manifests = require('./manifests')

const EventEmitter = require('events').EventEmitter
const inherits = require('inherits')
const muxrpc = require('muxrpc')
const wsClient = require('pull-ws/client')
const pull = require('pull-stream')

const RPC = muxrpc(manifests.server, manifests.client)

const noop = function () {}

const type = global.window ? 'web' : 'node'

const ServerRPC = muxrpc({
	subject: 'duplex',
	getSubject: 'duplex'
}, null)

const WebdhtDriver = function (config) {
	let self = this

	self._config = config
	self._connectors = {}
	self._connections = {}
	self._nextIdNum = 0
	self._destroyed = false

	let setupConn = function (connectorIdNum, conn) {
		let idNum = Object.keys(self._connections).find(function (elem) {
			return elem === conn
		})
		if (idNum === undefined) {
			idNum = self._nextIdNum++
			self._connections[idNum] = conn
			self._handle.onConnection(connectorIdNum, idNum, conn.id, noop)
			conn.on('stream', function (name, stream) {
				console.log('CLIENT STREAM')
				pull(stream, self._handle.connection.stream(idNum, name, noop), stream)
			})
			conn.on('close', function () {
				self._handle.connection.close(idNum, noop)
			})
			conn.on('direct', function () {
				self._handle.connection.direct(idNum, noop)
			})
		}
		return idNum
	}

	self._handle = RPC({
		createConnector: function (opts) {
			let connector = new Connector(opts)
			let idNum = self._nextIdNum++
			self._connectors[idNum] = connector
			connector.on('connection', function (conn) {
				setupConn(idNum, conn)
			})
			return idNum
		},
		connector: {
			destroy: function (idNum) {
				self._connectors[idNum].destroy()
				delete self._connectors[idNum]
			},
			connectTo: function (idNum, descriptor, cb) {
				if (descriptor.relay)
					descriptor.relay = self._connections[descriptor.relay]
				self._connectors[idNum].connectTo(descriptor, function (err, conn) {
					if (err)
						return cb(err)
					cb(err, setupConn(idNum, conn))
				})
			},
			connection: {
				openStream: function (idNum, name) {
					return self._connections[idNum].openStream(name)
				},
				close: function (idNum) {
					self._connections[idNum].close()
				},
				upgrade: function (idNum, cb) {
					// console.log('UPGRADE CALLED')
					// self._connections[idNum].upgrade(function (err) {
					// 	console.log('UPGRADE CALLBACK')
					// 	cb(err)
					// })
					self._connections[idNum].upgrade(cb)
				}
			}
		}
	})


	// self._connetionTimer = global.setTimeout(self._reconnect.bind(self), CONNECTION_TIMEOUT * 1000)

	wsClient(self._config.controlServer, {
		binary: true,
		onConnect: function (err, stream) {
			if (!self._destroyed && err) {
				console.error('failed to connect to control server')
				self.emit('error', err)
				return
			}
			self.emit('ready')

			self._serverHandle = ServerRPC()
			let subjectStream = self._serverHandle.subject(type, function (err) {
				console.log('subject callback')
				if (!self._destroyed && err)
					self.emit('error', err)
			})
			pull(subjectStream, self._handle.createStream(function (err) {
				if (!self._destroyed && err)
					return self.emit('error', err)
				if (!self._destroyed && !self._disconnected) {
					self._disconnected = true
					self.emit('disconnect')
				}
			}), subjectStream)

			pull(stream, self._serverHandle.createStream(function (err) {
				if (!self._destroyed && err)
					return self.emit('error', err)
				if (!self._destroyed && !self._disconnected) {
					self._disconnected = true
					self.emit('disconnect')
				}
			}), stream)

			self._handle.hello(function (err) {
				console.log('called hello')
				if (!self._destroyed && err)
					self.emit('error', err)
			})
		}
	})
}

inherits(WebdhtDriver, EventEmitter)

WebdhtDriver.prototype.destroy = function () {
	const self = this
	if (self._destroyed) return

	self._destroyed = true
	Object.values(self._connectors).forEach(function (connector) {
		connector.destroy()
	})

	if (self._handle)
		self._handle.close(noop)
	if (self._serverHandle)
		self._serverHandle.close()
}

WebdhtDriver.prototype.globalerror = function (args) {
	const self = this
	if (self._destroyed) return

	self._handle.globalerror(args, noop)
}

module.exports = WebdhtDriver


const CONNECTION_TIMEOUT = 10 // seconds
const RECONNECT_DELAY = 30 // seconds

let controlServer
if (global.location) {
	if (global.location.prototcol === 'https:')
		controlServer = 'wss://' + global.location.host
	else
		controlServer = 'ws://' + global.location.host
} else if (global.process) {
	controlServer = global.process.argv[2]
} else {
	throw new Error('unknown environment')
}

console.log('CONTROL SERVER:', controlServer)

let initialCall = true
function makeDriver () {
	if (!initialCall) {
		if (global.window)
			global.location.reload(true)
	}
	initialCall = false
	console.log('makeDriver')
	const driver = new WebdhtDriver({
		controlServer: controlServer
	})
	function restart () {
		console.log('restart')
		driver.destroy()
		global.setTimeout(makeDriver, RECONNECT_DELAY * 1000)
	}
	let timeout = global.setTimeout(function () {
		console.error('TIMEOUT')
		restart()
	}, CONNECTION_TIMEOUT * 1000)
	if (global.window) {
		global.onerror = function (message, source, lineno, colno) {
			console.log('CALLING globalerror')
			driver.globalerror({
				message,
				source,
				lineno,
				colno
			})
			return true
		}
	} else if (global.process) {
		process.on('uncaughtException', function (err) {
			driver.globalerror({
				message: err.message,
				source: err.fileName,
				lineno: err.lineNumber
			})
		})
	}
	let ready = false
	driver.on('ready', function () {
		ready = true
		console.log('ready')
		global.clearTimeout(timeout)
	})
	driver.on('error', function (err) {
		global.clearTimeout(timeout)
		if (ready) {
			driver.destroy()
			makeDriver()
		} else {
			// console.error(err)
			restart()
		}
	})
	driver.on('disconnect', function () {
		console.log('disconnect')
		global.clearTimeout(timeout)
		driver.destroy()
		makeDriver()
	})
}
makeDriver()


