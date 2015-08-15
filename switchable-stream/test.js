// var test = require('tape')
var net = require('net')

var SwitchableStream = require('./index')

var server1, server2, client1, client2

var toCreate = 4

var server = net.createServer(function (serverConn) {
	if (!server1)
		server1 = serverConn
	else
		server2 = serverConn
	if (--toCreate === 0)
		runTest()

})

client1 = net.createConnection(9999, function () {
	--toCreate
	client2 = net.createConnection(9999, function () {
		if (--toCreate === 0)
			runTest()
	})
})

server.listen(9999)

var runTest = function () {
	console.log('running')
	var serverEnd = new SwitchableStream(server1)
	var clientEnd = new SwitchableStream(client1)

	serverEnd.on('data', function (buffer) {
		console.log('got data on server:', buffer.toString())
	})
	clientEnd.on('data', function (buffer) {
		console.log('got data on client:', buffer.toString())
	})

	serverEnd.write(new Buffer('from server'))

	clientEnd.write(new Buffer('from client'))

	setTimeout(function () {
		serverEnd.replace(server2)
		clientEnd.replace(client2)

		setTimeout(function () {
			client1.destroy()
			server1.destroy()
			serverEnd.write(new Buffer('from server again'))
			clientEnd.write(new Buffer('from client again'))
		}, 100)
	}, 100)
}