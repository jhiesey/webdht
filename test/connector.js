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
			t.pass('server got stream')
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
				server.destroy()
				client1.destroy()
				client2.destroy()
				t.end()
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

// test('Upgrade to WebRTC', function (t) {
// 	var server = new Connector(ids[0], 8009)
// 	var client1 = new Connector(ids[1])
// 	var client2 = new Connector(ids[2])

// 	client2.on('connection', function (conn) {
// 		if (conn.id !== client1.id)
// 			return
// 		t.pass('got connection from right client')
// 		conn.on('stream', function (name, stream) {
// 			t.equals(name, 'name', 'got stream on client2')
// 			stream.on('data', function (data) {
// 				console.log(data.toString())
// 			})
// 		})

// 	})

// 	var count = 0
// 	function ready() {
// 		if (++count < 2)
// 			return

// 		client1.connectTo({
// 			id: client2.id,
// 			bridge: client1Server
// 		}, function (err, conn) {
// 			t.notOk(err, 'indirect connectTo')
// 			if (err)
// 				return console.error(err)

// 			var stream = conn.openStream('name')
// 			stream.write('hi there')



// 			// conn.upgrade(function (err) {
// 			// 	t.notOk(err, 'upgrade')
// 			// 	if (err)
// 			// 		return console.error(err)
// 			// 	t.end()
// 			// 	server.destroy()
// 			// 	client1.destroy()
// 			// 	client2.destroy()
// 			// })
// 		})
// 	}

// 	client1.connectTo({
// 		url: 'ws://localhost:8009'
// 	}, function (err, conn) {
// 		t.notOk(err, 'client1 connectTo')
// 		if (err)
// 			return console.error(err)
// 		client1Server = conn
// 		ready()
// 	})

// 	client2.connectTo({
// 		url: 'ws://localhost:8009'
// 	}, function (err, conn) {
// 		t.notOk(err, 'client2 connectTo')
// 		if (err)
// 			return console.error(err)
// 		client2Server = conn
// 		ready()
// 	})
// })
