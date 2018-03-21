var Connector = require('./../lib/connector')
var test = require('tape')

let pull = require('pull-stream')
let pullCollect = require('pull-stream/sinks/collect')
let pullOnce = require('pull-stream/sources/once')

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
	var server = new Connector({id: ids[0], wsPort: 8009})
	var client = new Connector({id: ids[1]})

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

test('Connect through relay', function (t) {
	var server = new Connector({id: ids[0], wsPort: 8009})
	var client1 = new Connector({id: ids[1]})
	var client2 = new Connector({id: ids[2]})

	client2.on('connection', function (conn) {
		if (conn.id !== client1.id)
			return
		t.pass('got connection from right client')
		conn.on('stream', function (name, stream) {
			t.equals(name, 'name', 'got stream on client2')

			pull(stream, pullCollect(function (err, s) {
				t.notOk(err, 'no stream error')
				t.ok(Buffer.concat(s).equals(new Buffer('hi!')), 'correct data')
				server.destroy()
				client1.destroy()
				client2.destroy()
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

			pull(pullOnce(Buffer.from('hi!')), conn.openStream('name'))
		})
	}

	client1.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'client1 connectTo')
		if (err)
			return console.error(err)
		client1Server = conn
		ready()
	})

	client2.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'client2 connectTo')
		if (err)
			return console.error(err)
		client2Server = conn
		ready()
	})
})

test('Upgrade to WebRTC', function (t) {
	var server = new Connector({id: ids[0], wsPort: 8009})
	var client1 = new Connector({id: ids[1]})
	var client2 = new Connector({id: ids[2]})
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

test('Simultaneous websocket connections', function (t) {
	var server1 = new Connector({id: ids[0], wsPort: 8009})
	var server2 = new Connector({id: ids[1], wsPort: 8010})

	var finished = false
	var server1Incoming, server1Outgoing, server2Incoming, server2Outgoing
	function end () {
		if (true) {
			t.equal(server1Incoming, server1Outgoing, 'server 1 same connection')
			t.equal(server2Incoming, server2Outgoing, 'server 2 same connection')
			server1.destroy()
			server2.destroy()
			t.end()
		}
		finished = true
	}

	server1.on('connection', function (conn) {
		server1Incoming = conn
		t.equal(conn.id, server2.id, 'got connection from server 2')
		conn.on('stream', function (name, stream) {
			t.equal(name, 'myStream1', 'server 1 got stream')
			pull(stream, pullCollect(function (err, s) {
				t.notOk(err, 'no stream error')
				t.ok(Buffer.concat(s).equals(new Buffer('hi!')), 'correct data')
				end()
			}))
		})
	})

	server2.on('connection', function (conn) {
		server2Incoming = conn
		t.equal(conn.id, server1.id, 'got connection from server 1')
		conn.on('stream', function (name, stream) {
			t.equal(name, 'myStream2', 'server 2 got stream')
			pull(stream, pullCollect(function (err, s) {
				t.notOk(err, 'no stream error')
				t.ok(Buffer.concat(s).equals(new Buffer('hi again')), 'correct data')
				end()
			}))
		})
	})

	server2.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'server 2 connectTo')
		if (err)
			return console.error(err)
		server2Outgoing = conn
		pull(pullOnce(Buffer.from('hi!')), conn.openStream('myStream1'))
	})

	server1.connectTo({
		url: 'ws://localhost:8010'
	}, function (err, conn) {
		t.notOk(err, 'server 1 connectTo')
		if (err)
			return console.error(err)
		server1Outgoing = conn
		pull(pullOnce(Buffer.from('hi again')), conn.openStream('myStream2'))
	})
})

test('Simultaneous upgrade to WebRTC', function (t) {
	var server = new Connector({id: ids[0], wsPort: 8009})
	var client1 = new Connector({id: ids[1]})
	var client2 = new Connector({id: ids[2]})

	var client2Incoming, client1Outgoing
	var indirectCount = 0
	function indirectReady() {
		if (++indirectCount < 2)
			return

		client1Outgoing.upgrade(function (err) {
			t.notOk(err, 'upgraded')
			if (err)
				return

			pull(pullOnce(Buffer.from('hi!')), client1Outgoing.openStream('name'))
		})

		client2Incoming.upgrade(function (err) {
			t.notOk(err, 'upgraded')
			if (err)
				return
		})

		client2Incoming.on('stream', function (name, stream) {
			t.equals(name, 'name', 'got stream on client2')
			pull(stream, pullCollect(function (err, s) {
				t.notOk(err, 'no stream error')
				t.ok(Buffer.concat(s).equals(new Buffer('hi!')), 'correct data')
				client1.destroy()
				client2.destroy()
				server.destroy()
				t.end()
			}))
		})
	}

	client2.on('connection', function (conn) {
		if (conn.id !== client1.id)
			return
		t.pass('got connection from right client')
		client2Incoming = conn
		indirectReady()
	})

	var websocketCount = 0
	function websocketsReady() {
		if (++websocketCount < 2)
			return

		client1.connectTo({
			id: client2.id,
			relay: client1Server
		}, function (err, conn) {
			t.notOk(err, 'indirect connectTo')
			if (err)
				return console.error(err)
			client1Outgoing = conn
			indirectReady()
		})
	}

	client1.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'client1 connectTo')
		if (err)
			return console.error(err)
		client1Server = conn
		websocketsReady()
	})

	client2.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'client2 connectTo')
		if (err)
			return console.error(err)
		client2Server = conn
		websocketsReady()
	})
})

test('quit', function (t) {
	t.end()
	process.exit(0)
})
