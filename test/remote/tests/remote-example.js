const RemoteConnectorClient = require('../client/remote-connector')
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

test.skip('Basic websocket connection', function (t) {
	let tc = new RemoteConnectorClient('ws://localhost:8001')
	tc.on('error', function (err) {
		t.fail(err)
	})
	tc.getConnectors([{id: ids[0], wsPort: 8009}, {id: ids[1]}], function (err, connectors) {
		t.notOk(err)
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
					tc.destroy()
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
})

test('Upgrade to WebRTC', function (t) {
	let tc = new RemoteConnectorClient('ws://localhost:8001')
	tc.on('error', function (err) {
		t.fail(err)
	})
	tc.getConnectors([{id: ids[0], wsPort: 8009}, {id: ids[1]}, {id: ids[2]}], function (err, connectors) {
		t.notOk(err)
		var server = connectors[0]
		var client1 = connectors[1]
		var client2 = connectors[2]
		let client1Conn, client2Conn

		var serverConns = []
		server.on('connection', function (conn) {
			serverConns.push(conn)
			conn.on('close', function () {
				console.log('SERVER CONN CLOSED')
				serverConns.splice(serverConns.indexOf(conn), 1)

				if (serverConns.length === 0) {
					t.pass('server connections all closed')
					// TODO: this is never running!
					client1.destroy()
					client2.destroy()
					server.destroy()
				}
			})
		})

		client2.on('connection', function (conn) {
			if (conn.id !== client1.id)
				return
			t.pass('got connection from right client')
			conn.on('stream', function (name, stream) {
				t.equals(name, 'name', 'got stream on client2')

				pull(stream, pullCollect(function (err, s) {
					t.notOk(err, 'no stream error')
					t.ok(Buffer.concat(s).equals(new Buffer('hi!')), 'correct data')

					client1Conn.close()
					client2Conn.close()

					// TODO: should happen above
					client1.destroy()
					client2.destroy()
					server.destroy()

					tc.destroy()
					t.end()
				}))
			})
		})

		var count = 0
		function ready() {
			if (++count < 2)
				return

			client1.connectTo({
				id: client2.id,
				relay: client1Server
			}, function (err, conn) {
				t.notOk(err, 'indirect connectTo')
				if (err)
					return console.error(err)

				conn.upgrade(function (err) {
					t.notOk(err, 'upgraded')
					if (err)
						return

					pull(pullOnce(Buffer.from('hi!')), conn.openStream('name'))
				})
			})
		}

		client1.connectTo({
			url: 'ws://localhost:8009'
		}, function (err, conn) {
			client1Conn = conn
			t.notOk(err, 'client1 connectTo')
			if (err)
				return console.error(err)
			client1Server = conn
			ready()
		})

		client2.connectTo({
			url: 'ws://localhost:8009'
		}, function (err, conn) {
			client2Conn = conn
			t.notOk(err, 'client2 connectTo')
			if (err)
				return console.error(err)
			client2Server = conn
			ready()
		})
	})

})
