const TestClient = require('./remote-connector')
const test = require('tape')
const async = require('async')

const pull = require('pull-stream')
const pullCollect = require('pull-stream/sinks/collect')
const pullOnce = require('pull-stream/sources/once')

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
	let client = new TestClient('ws://localhost:8001')
	client.getConnectors([{id: ids[0], wsPort: 8009}, {id: ids[1]}], function (err, connectors) {
		console.log('getConnectors RETURNED')
		if (err) {
			console.log(err)
			return t.fail(err)
		}
		let server = connectors[0]
		let client = connectors[1]

		server.on('connection', function (conn) {
			t.equal(conn.id, client.id, 'got connection from right client')
			conn.on('stream', function (name, stream) {
				t.equal(name, 'myStream', 'server got stream')

				pull(stream, pullCollect(function (err, s) {
					t.notOk(err, 'no stream error')
					t.ok(Buffer.concat(s).equals(new Buffer('hi!')), 'correct data')
					server.destroy()
					client.destroy()
					t.end()
				}))
			})
		})

		client.connectTo({
			url: 'ws://localhost:8009'
		}, function (err, conn) {
			t.notOk(err, 'connectTo')
			if (err)
				return console.error(err)
			pull(pullOnce(Buffer.from('hi!')), conn.openStream('myStream'))
		})
	})
	


	// var server = new Connector({id: ids[0], wsPort: 8009})
	// var client = new Connector({id: ids[1]})

	// server.on('connection', function (conn) {
	// 	t.equal(conn.id, client.id, 'got connection from right client')
	// 	conn.on('stream', function (name, stream) {
	// 		t.equal(name, 'myStream', 'server got stream')

	// 		pull(stream, pullCollect(function (err, s) {
	// 			t.notOk(err, 'no stream error')
	// 			t.ok(Buffer.concat(s).equals(new Buffer('hi!')), 'correct data')
	// 			server.destroy()
	// 			client.destroy()
	// 			t.end()
	// 		}))
	// 	})
	// })

	// client.connectTo({
	// 	url: 'ws://localhost:8009'
	// }, function (err, conn) {
	// 	t.notOk(err, 'connectTo')
	// 	if (err)
	// 		return console.error(err)
	// 	pull(pullOnce(Buffer.from('hi!')), conn.openStream('myStream'))
	// })
})




// client.on('ready', function () {
// 	console.log('READY')
// 	client.getNode('web', function (err, node) {
// 		if (err)
// 			return console.error('ERROR', err)
// 		node.on('disconnect', function () {
// 			console.log('DISCONNECTED')
// 		})
// 		console.log('GOT NODE')
// 	})
// })