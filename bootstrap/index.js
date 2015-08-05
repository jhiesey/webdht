var http = require('http')
var express = require('express')
var path = require('path')
var rpc = require('rpc-stream')
var websocket = require('websocket-stream')

var NUM_PEERS_PER_REQUEST = 30

var app = express()
var s = http.createServer(app)

function BootstrapServer (server) {
	var self = this
	self.nodes = {} // all known nodes
	self.unknownAddress = []

	self.wss = websocket.createServer({
		server: server
	}, function (stream) {
		new Node(stream, self)
	})
}

BootstrapServer.prototype.onSendOffer = function (from, id, offer, cb) {
	var self = this
	var node = self.nodes[id]

	if (!node) {
		return cb(new Error('node not connected'))
	}

	// console.log('offer:', offer)

	node.handle.offer(from.id, offer, cb)
}

BootstrapServer.prototype.getNodes = function () {
	var self = this

	var allNodes = Object.keys(self.nodes)

	// Choose a random subset of allNodes
	var chosenNodes = []
	while (chosenNodes.length < NUM_PEERS_PER_REQUEST && allNodes.length) {
		var index = Math.floor(Math.random() * allNodes.length)
		chosenNodes.push(allNodes[index])
		allNodes.splice(index, 1)
	}

	return chosenNodes

	// var knownToThem = {}
	// var unknownToUs = []
	// nodes.forEach(function (node) {
	// 	knownToThem[node] = true
	// 	if (!node in self.nodes)
	// 		unknownToUs.push(node)
	// })

	// //TODO: try to connect to unknownToUs


	// var knownToUs = []
	// Object.keys(self.nodes).forEach(function (node) {
	// 	if (node.connected)
	// 		knownToUs.push(node)
	// })

	// unknownToThem = []
	// knownToUs.forEach(function (node) {
	// 	if (!knownToThem[node])
	// 		unknownToThem.push(node)
	// })

	// return unknownToThem
}

function Node (stream, bootstrap) {
	var self = this

	self.bootstrap = bootstrap

	self.id = null
	self._stream = stream
	self._destroyed = false

	var rpcInstance = rpc({
		getNodes: function (myId, cb) {
			if (self.id === null) {
				self.id = myId
				if (myId in bootstrap.nodes) {
					bootstrap.nodes[myId].destroy()
				}
				// add to nodes and remove from unknownAddress
				bootstrap.nodes[myId] = self
				var unknownInd = bootstrap.unknownAddress.indexOf(self)
				bootstrap.unknownAddress.splice(unknownInd, 1)
			}
			if (self.id !== myId) {
				return cb(new Error('node id does not match'))
			}
			cb(null, bootstrap.getNodes())
		},
		sendOffer: bootstrap.onSendOffer.bind(bootstrap, self)
	})

	stream.on('close', self.destroy.bind(self))

	self.handle = rpcInstance.wrap(['offer'])
	rpcInstance.pipe(stream).pipe(rpcInstance)
	bootstrap.unknownAddress.push(self)
}

Node.prototype.destroy = function (stream) {
	var self = this

	if (self._destroyed)
		return

	self._destroyed = true
	if (self._stream)
		self._stream.destroy()

	delete self.bootstrap.nodes[self.id]
	var unknownInd = self.bootstrap.unknownAddress.indexOf(self)
	if (unknownInd >= 0)
		self.bootstrap.unknownAddress.splice(unknownInd, 1)
}

app.use(express.static(path.join(__dirname, 'static')))

new BootstrapServer(s)

s.listen(8080)