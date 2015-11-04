var Overlay = require('./lib/overlay')

var hat = require('hat')

var ID_BITS = 160

var id = hat(ID_BITS)

console.log('my id:', id)

var overlay
if (typeof window === 'undefined') {
	overlay = new Overlay(id, 8085, [])
}
else {
	overlay = new Overlay(id, null, ['ws://localhost:8085'])
	window.overlay = overlay
}

overlay.on('stream', function (id, name, str) {
	console.log('incoming stream from node with id:', id, 'name:', name)
	global.stream = str
	str.on('data', function (data) {
		console.log(id + ':', data.toString())
	})
})

global.createStream = function (id, name) {
	console.log('outgoing stream with id:', id)
	overlay.openStream(id, name, {}, function (err, strs) {
		if (err) {
			return console.error(err)
		}
		var str = strs[0]
		global.stream = str
		str.on('data', function (data) {
			console.log(id + ':', data.toString())
		})
	})
}
