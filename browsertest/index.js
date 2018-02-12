const Connector = require('../lib/connector')
const http = require('http')
const rpc = require('rpc-stream')
const SimpleWebsocket = require('simple-websocket')

let WebdhtDriver = function (config) {
	let self = this
	self._conns = {}
	self._streams = {}

	const controlServer = config.controlServer
	self._controlSocket = new SimpleWebsocket(controlServer)
	self._controlSocket.on('connect', function () {
		self._handle.ready({
			isBrowser: (typeof window !== 'undefined')
		})
	})

	const r = new rpc({
		connectTo: function (descriptor, cb) {
			if (!self._connector)
				return cb(new Error('not created yet'))

			if (!descriptor.id)
				return cb(new Error('id not specified'))

			self._connector.connectTo(descriptor, function (err, conn) {
				if (err)
					return cb(err)

				cb(null, true)
			})
		},
		create: function (config, cb) {
			if (self._connector)
				return cb(new Error('already created'))

			self._connector = new Connector(config)
			self._connector.on('connection', function (conn) {
				self._newConnection(conn)
			})
			cb(null, true)
		},
		destroy: function (cb) {
			if (!self._connector)
				return cb(null, false)

			self._connector.destroy()
			cb(null, true)
		},
		createStream: function (id, name, shared, cb) {
			if (!self._connector)
				return cb(new Error('not created yet'))

			let conn = self._conns[id]
			if (!conn)
				return cb(new Error('not connected'))

			let stream = conn.openStream(name, shared)
			self._newStream(id, name, stream)

			cb(null, true)
		},
		write: function (id, streamName, buf, cb) {
			if (!self._connector)
				return cb(new Error('not created yet'))

			if (!self._conns[id] || !self._conns[id][streamName])
				return cb(new Error('stream does not exist'))

			self._conns[id][streamName].write(buf, cb)
		}
		end: function (id, streamName, cb) {
			if (!self._connector)
				return cb(new Error('not created yet'))

			if (!self._conns[id] || !self._conns[id][streamName])
				return cb(new Error('stream does not exist'))

			self._conns[id][streamName].end(cb)
		}
	})

	self._controlSocket.pipe(r).pipe(self._controlSocket)
	self._handle = r.wrap(['connectionDirect', 'connectionClose', 'connected', 'ready', 'duplicateConnection', 'duplicateStream', 'streamClose', 'data', 'end', 'globalerror'])
}

WebdhtDriver.prototype._newConnection = function (conn) {
	let self = this

	const id = conn.id

	if (self._conns[id]) {
		// this shouldn't happen
		self._conns[id].destroy()
		self._handle.duplicateConnection(id)
	}

	self._conns[id] = conn
	self._streams[id] = {}

	self._handle.connected(id)

	conn.on('close', function () {
		delete self._conns[id]
		self._handle.connectionClose(id)
	})

	conn.on('direct', function () {
		self._handle.connectionDirect(id)
	})

	conn.on('stream', function (name, stream) {
		self._newStream(id, name, stream)
	})
}

WebdhtDriver.prototype._newStream = function (id, name, stream) {
	let self = this

	if (self._streams[id][name]) {
		self._handle.duplicateStream(id, name)
	}
	self._streams[id][name] = stream

	stream.on('close', function () {
		self._handle.streamClose(id, name)
		delete self._streams[id][name]
	})

	stream.on('data', function (buf) {
		self._handle.data(id, name, buf)
	})

	stream.on('end', function () {
		self._handle.end(id, name)
	})
}

WebdhtDriver.prototype.globalerror = function (data) {
	let self = this

	self._handle.globalerror(data)
}

module.exports = WebdhtDriver