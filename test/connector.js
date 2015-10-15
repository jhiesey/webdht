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
		t.equal(conn.id, client.id, 'got connection from right client')
		conn.on('stream', function (name, stream) {
			t.equal(name, 'myStream', 'server got stream')
			var buffers = []
			stream.on('data', function (data) {
				buffers.push(data)
			})
			stream.on('end', function () {
				t.equals(Buffer.concat(buffers).toString(), 'hi!', 'correct data')
				server.destroy()
				client.destroy()
				t.end()
			})
		})
	})

	client.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'connectTo')
		if (err)
			return console.error(err)
		var stream = conn.openStream('myStream')
		stream.write('hi!')
		stream.end()
	})
})

test('Connect through bridge', function (t) {
	var server = new Connector(ids[0], 8009)
	var client1 = new Connector(ids[1])
	var client2 = new Connector(ids[2])

	client2.on('connection', function (conn) {
		if (conn.id !== client1.id)
			return
		t.pass('got connection from right client')
		conn.on('stream', function (name, stream) {
			t.equals(name, 'name', 'got stream on client2')
			var buffers = []
			stream.on('data', function (data) {
				buffers.push(data)
			})
			stream.on('end', function () {
				t.equals(Buffer.concat(buffers).toString(), 'hi!', 'correct data')
				client1.destroy()
				client2.destroy()
				setTimeout(function () { // TODO: fix cleanup
					server.destroy()
					t.end()
				}, 100)
			})
		})

	})

	var count = 0
	function ready() {
		if (++count < 2)
			return

		client1.connectTo({
			id: client2.id,
			bridge: client1Server
		}, function (err, conn) {
			t.notOk(err, 'indirect connectTo')
			if (err)
				return console.error(err)

			var stream = conn.openStream('name')
			stream.write('hi!')
			stream.end()
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
	var server = new Connector(ids[0], 8009)
	var client1 = new Connector(ids[1])
	var client2 = new Connector(ids[2])

	client2.on('connection', function (conn) {
		if (conn.id !== client1.id)
			return
		t.pass('got connection from right client')
		conn.on('stream', function (name, stream) {
			t.equals(name, 'name', 'got stream on client2')
			var buffers = []
			stream.on('data', function (data) {
				buffers.push(data)
			})
			stream.on('end', function () {
				t.equals(Buffer.concat(buffers).toString(), 'hi!', 'correct data')
				client1.destroy()
				//client2.destroy()
				setTimeout(function () { // TODO: fix cleanup
					server.destroy()
					t.end()
				}, 100)
			})
		})
	})

	var count = 0
	function ready() {
		if (++count < 2)
			return

		client1.connectTo({
			id: client2.id,
			bridge: client1Server
		}, function (err, conn) {
			t.notOk(err, 'indirect connectTo')
			if (err)
				return console.error(err)

			conn.upgrade(function (err) {
				t.notOk(err, 'upgraded')
				if (err)
					return

				var stream = conn.openStream('name')
				stream.write('hi!')
				stream.end()
			})
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

test('Simultaneous websocket connections', function (t) {
	var server1 = new Connector(ids[0], 8009)
	var server2 = new Connector(ids[1], 8010)

	var finished = false
	var server1Incoming, server1Outgoing, server2Incoming, server2Outgoing
	function end () {
		if (finished) {
			t.equal(server1Incoming, server1Outgoing, 'server 1 same connection')
			t.equal(server2Incoming, server2Outgoing, 'server 2 same connection')
			server1.destroy()
			server2.destroy()
			t.end()
		}
		finished = true
	}

	var finished = false
	server1.on('connection', function (conn) {
		server1Incoming = conn
		t.equal(conn.id, server2.id, 'got connection from server 2')
		conn.on('stream', function (name, stream) {
			t.equal(name, 'myStream1', 'server 1 got stream')
			var buffers = []
			stream.on('data', function (data) {
				buffers.push(data)
			})
			stream.on('end', function () {
				t.equals(Buffer.concat(buffers).toString(), 'hi!', 'correct data')
				end()
			})
		})
	})

	server2.on('connection', function (conn) {
		server2Incoming = conn
		t.equal(conn.id, server1.id, 'got connection from server 1')
		conn.on('stream', function (name, stream) {
			t.equal(name, 'myStream2', 'server 2 got stream')
			var buffers = []
			stream.on('data', function (data) {
				buffers.push(data)
			})
			stream.on('end', function () {
				t.equals(Buffer.concat(buffers).toString(), 'hi again', 'correct data')
				end()
			})
		})
	})

	server2.connectTo({
		url: 'ws://localhost:8009'
	}, function (err, conn) {
		t.notOk(err, 'server 2 connectTo')
		if (err)
			return console.error(err)
		server2Outgoing = conn
		var stream = conn.openStream('myStream1')
		stream.write('hi!')
		stream.end()
	})

	server1.connectTo({
		url: 'ws://localhost:8010'
	}, function (err, conn) {
		t.notOk(err, 'server 1 connectTo')
		if (err)
			return console.error(err)
		server1Outgoing = conn
		var stream = conn.openStream('myStream2')
		stream.write('hi again')
		stream.end()
	})
})
