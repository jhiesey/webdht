var Overlay = require('./lib/overlay')

var hat = require('hat')

var ID_BITS = 160

/*
TODO list:
CHECK handle both sides trying to connect
CHECK handle both sides trying to switch to direct
CHECK proper routing table
CHECK ref counting
CHECK handle disconnects (all structure except self._allNodes is transient)
CHECK Nesting depth? at any rate, some way to decide when to connect directly
CHECK Counting in-progress requests
CHECK Better interface: create a node store!

TODO:
Separate Node, DHT, and RoutingTable into separate files


limit number of real connections in a bucket (2?)
	OR: limit total size of routing table pool. size per bucket changes dynamically
limit number of total connections in a bucket (10?)
*/

/*
Concept: Node is base class, BootstrapNode is subclass
Methods:
* connect(direct)
*	'connect'
*	'direct'
* openStream() for clients
* findNode()

*/


/*
Peers can be:
* Known and have a gateway
* Connecting
* Connected

Essentially, the gateway and connection can exist orthogonally to each other.
If the connection disconnects, peer disappears
If the gateway disappears and there is no connection, peer disappears

gateway can be a peer or bootstrap node


ONCE NODE IS CONSTRUCTED, SHOULD BE CONNECTED!
*/


var id = hat(ID_BITS)

console.log('my id:', id)

var overlay
if (typeof window === 'undefined') {
	overlay = new Overlay(id, [], 8085)
}
else {
	overlay = new Overlay(id, ['ws://localhost:8085'])
	window.overlay = overlay
}

overlay.on('stream', function (err, id, str) {
	console.log('incoming stream with id:', id)
	global.stream = str
	str.on('data', function (data) {
		console.log(id + ':', data.toString())
	})
})

global.createStream = function (node, id) {
	console.log('outgoing stream with id:', id)
	overlay.sendStream(node, id, function (err, str) {
		if (err) {
			console.error('failed to create stream with id:', id)
		}
		global.stream = str
		str.on('data', function (data) {
			console.log(id + ':', data.toString())
		})
	})

}
