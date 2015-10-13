var Connector = require('./../lib/connector')
var test = require('tape')

var ids = [
	'd8a775cb11dd85f3610b5e686bdd944763e581b2',
	'0d2afaf28eb637eb24b90fc32beaa2a0f06c3b65',
	'2c8ec15aafcda4594fcff163a916204fb11d5832',
	'900e6135b4c4638d7fcb5015fd9b7ec65d390538',
	'0e3a720178da04beece2978d1e5657594432876b',
	'b895d5d12efa8ee75e55d9ca218ed7cc8cafc462',
	'8c1f7571177c1b5758cd691c99f942c8f6fa6f9d',
	'34ee2367d81ba9db2c70cb5591a13b8b2478fd8f',
	'21cd7069d24a7018cf0e5373d9da77578cc6008c',
	'e2d436b8730be3b696e1073028f33ec349287f5a'
]

test('Basic websocket connection', function (t) {
	var server = new Connector(ids[0], 8009)
	var client = new Connector(ids[1])

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
				t.end()
				server.destroy()
				client.destroy()
			})
		})
	})

	client.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		if (err) {
			t.fail('connectTo failed')
			return console.error(err)
		}
		t.pass('client connected')
		var stream = conn.openStream('myStream')
		stream.write('hi!')
		stream.end()
	})
})

test('Upgrade to WebRTC', function (t) {
	var server = new Connector(ids[])
})