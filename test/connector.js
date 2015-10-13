var Connector = require('./../lib/connector')
var test = require('tape')

test('Basic websocket connection', function (t) {

	var serverId = '8e2972040d36d9dfba6b7a0bfc5b9bdac28f2588'
	var server = new Connector(serverId, 8009)

	server.on('connection', function (conn) {
		t.pass('server got connection')
		conn.on('stream', function (name, stream) {
			var buffers = []
			t.pass('server got stream')
			stream.on('data', function (data) {
				buffers.push(data)
			})
			stream.on('end', function () {
				t.equals(Buffer.concat(buffers).toString(), 'hi!', 'correct data')
			})
		})
	})

	var clientId = '72201ee75729116ba2b9625d50440918375a7e38'
	var client = new Connector(clientId)

	client.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		if (err) {
			t.fail('connectTo failed')
			return console.error(err)
		}
		t.ok('client connected')
		var stream = conn.openStream('myStream')
		stream.write('hi!')
		stream.end()
	})
})
