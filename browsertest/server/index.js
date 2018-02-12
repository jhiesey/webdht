const hat = require('hat')
const http = require('http')
const rpc = require('rpc-stream')

let nodes = {}

const peerOpts = {

}

let NODE_LISTEN_PORT = 8765

/*
High level idea:
	* when node connects, assign it an id and store in nodes

	* provide testing api:
		* node selection (random, neighbor of, etc.)
		* connect, testStream
		* handle errors

	* log all events in db



Let's say tests run sequentially. There is a graph
of what tests must have run before a given test.
Each test has a timeout.

What are preconditions for tests?
* minimum total nodes (wait)
* particular network structure (actively change)

What tests do we want to run?
* make sure we can connect to neighbors
* make sure connections close when not needed

OK, so maybe it's just *one* test which runs continuously.
Could run other tests inside
*/



// TODO: inherit from EventEmitter
let Node = function (id, socket) {
	var self = this

	self.id = id
	self.ready = false
	self._r = new rpc({
		ready: function (config) {
			const wsPort = config.isBrowser ? undefined : NODE_LISTEN_PORT
			self._handle.create({
				id: id,
				peer: peerOpts,
				wsPort
			}, function (err, success) {
				if (err)
					return self.error(err)

				self.ready = true
				self.emit('ready')
			})
		},
		connectionDirect: function () {

		},
		connectionClose: function () {

		},
		connected: function () {

		},
		duplicateConnection: function () {

		},
		duplicateStream: function () {

		},
		streamClose: function () {

		},
		data: function () {

		},
		end: function () {

		},
		globalerror: function () {

		}
	})
	socket.pipe(self._r).pipe(socket)

	self._handle = self._r.wrap(['connectTo', 'create', 'destroy', 'createStream', 'write', 'end'])
}

Node.prototype.error = function (err) {
	// log error
}
