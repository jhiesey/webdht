var Overlay = require('./lib/overlay')

var hat = require('hat')

var ID_BITS = 160

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
