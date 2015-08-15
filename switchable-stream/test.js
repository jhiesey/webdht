// var test = require('tape')
var ashify = require('ashify')
var fs = require('fs')
var net = require('net')
var path = require('path')

var SwitchableStream = require('./index')

var server1, server2, client1, client2

var toCreate = 4

var s1 = net.createServer(function (serverConn) {
	server1 = serverConn
	if (--toCreate === 0)
		runTest()
})
var s2 = net.createServer(function (serverConn) {
	server2 = serverConn
	if (--toCreate === 0)
		runTest()
})

client1 = net.createConnection(9998, function () {
	if (--toCreate === 0)
		runTest()
})
client2 = net.createConnection(9999, function () {
	if (--toCreate === 0)
		runTest()
})

s1.listen(9998)
s2.listen(9999)

var runTest = function () {
	// console.log('running')
	// var serverEnd = new SwitchableStream(server1)
	// var clientEnd = new SwitchableStream(client1)

	// serverEnd.on('data', function (buffer) {
	// 	console.log('got data on server:', buffer.toString())
	// })
	// clientEnd.on('data', function (buffer) {
	// 	console.log('got data on client:', buffer.toString())
	// })

	// serverEnd.write(new Buffer('from server'))

	// clientEnd.write(new Buffer('from client'))

	// setTimeout(function () {
	// 	serverEnd.replace(server2)
	// 	clientEnd.replace(client2)

	// 	setTimeout(function () {
	// 		client1.destroy()
	// 		server1.destroy()
	// 		serverEnd.write(new Buffer('from server again'))
	// 		clientEnd.write(new Buffer('from client again'))
	// 	}, 100)
	// }, 100)



	var serverClientData = fs.createReadStream(path.join(__dirname, 'test-data'))
	var clientServerData = fs.createReadStream(path.join(__dirname, 'test-data'))
	var refData = fs.createReadStream(path.join(__dirname, 'test-data'))

	var serverEnd = new SwitchableStream(server1)
	var clientEnd = new SwitchableStream(client1)

	serverClientData.pipe(serverEnd)
	clientServerData.pipe(clientEnd)
	var ashifyOpts = {
		algorithm: 'sha1',
		encoding: 'hex'
	}
	ashify(refData, ashifyOpts, function (err, data) {
		if (err)
			console.error(err)
		else
			console.log('direct hash:', data)
	})

	ashify(clientEnd, ashifyOpts, function (err, data) {
		if (err)
			console.error(err)
		else
			console.log('client end received:', data)
	})

	ashify(serverEnd, ashifyOpts, function (err, data) {
		if (err)
			console.error(err)
		else
			console.log('server end received:', data)
	})

	serverEnd.on('switched', function () {
		console.log('switched')
		server1.destroy()
	})
	clientEnd.on('switched', function () {
		console.log('switched')
		client1.destroy()
	})

	setTimeout(function () {
		serverEnd.replace(server2)
		setTimeout(function () {
			clientEnd.replace(client2)
		}, 100)
	}, 100)

}

