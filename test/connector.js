var Connector = require('./../lib/connector')

var serverId = '8e2972040d36d9dfba6b7a0bfc5b9bdac28f2588'
var server = new Connector(serverId, 8009)

server.on('connection', function (conn) {
	console.log('server got connection')
	conn.on('stream', function (name, stream) {
		console.log('server got stream:', name)
		stream.on('data', function (data) {
			console.log(data.toString())
		})
	})
})

var clientId = '72201ee75729116ba2b9625d50440918375a7e38'
var client = new Connector(clientId)

client.connectTo({
	url: 'ws://localhost:8009'
}, function (err, conn) {
	if (err)
		return console.error(err)
	console.log('client connected')
	var stream = conn.openStream('myStream')
	stream.write('hi!')
})
