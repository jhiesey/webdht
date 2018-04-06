/*
High level architecture:
Server accepts two types of connections:
1. Connections from test subjects (http and websocket)
2. Connections from test runners

Are these two types of connections piped together?

What happens on error?

Let's say test subject connects to server, which then
eventually connects to runner.
On error/close, destroy connector(s)


Runner -> server interface:
* get node
Does that wait for a node to be available?
Presumably yes.

How do we request browser vs. node subjects?
OK, then connect via nested muxrpc *on both sides*


*/

const TEST_PORT = 8001

const pullError = require('pull-stream/sources/error')
const DuplexPair = require('pull-pair/duplex')
const muxrpc = require('muxrpc')
const defer = require('pull-defer')
const wsServer = require('pull-ws/server')
const http = require('http')
const express = require('express')
const path = require('path')
const pull = require('pull-stream')

const app = express()
const server = http.createServer(app)

app.use(express.static(path.join(__dirname, 'static')))

const RPC = muxrpc(null, {
	subject: 'duplex',
	getSubject: 'duplex'
})

let subjects = [] // {type: 'type', stream: stream, conn: stream }
let awaitingSubjects = [] // {type: 'type', cb: cb, conn: stream }

let onNewSubject = function (type, stream, conn) {
	for (let i = 0; i < awaitingSubjects.length; i++) {
		let e = awaitingSubjects[i]
		if (e.type === 'any' || e.type === type) {
			awaitingSubjects.splice(i, 1)
			e.cb(null, stream)
		}
	}

	subjects.push({type: type, stream: stream, conn: conn})
}

let onGetSubject = function (type, conn) {
	for (let i = 0; i < subjects.length; i++) {
		let e = subjects[i]
		if (type === 'any' || e.type === type) {
			subjects.splice(i, 1)
			console.log('returning existing stream')
			return e.stream
		}
	}

	console.log('waiting for stream')
	let duplex = defer.duplex()

	awaitingSubjects.push({
		type: type,
		cb: function (err, stream) {
			duplex.resolve(stream)
		},
		conn: conn
	})

	return duplex
}

let noop = function () {}

let errorStream = function (err) {
	return {
		sink: noop,
		source: pullError(err)
	}
}

let socketServer = wsServer({
	server: server,
}, function (stream) {
	console.log('NEW STREAM')
	let subjectCalled = false
	let getSubjectCalled = false
	let handle = RPC({
		subject: function (type) {
			console.log('GOT SUBJECT', type)
			if (subjectCalled || getSubjectCalled)
				return errorStream(new Error('unexpected subject call'))
			if (type === 'node' || type === 'web') {
				let duplex = DuplexPair()
				onNewSubject(type, duplex[0], stream)
				subjectCalled = true
				return duplex[1]
			} else {
				return errorStream(new Error('unexpected type'))
			}
		},
		getSubject: function (type) {
			console.log('GOT GETSUBJECT', type)
			if (subjectCalled)
				return errorStream(new Error('unexpected getSubject call'))
			getSubjectCalled = true
			return onGetSubject(type, stream)
		}
	})

	pull(stream, handle.createStream(function (err) {
		for (let i = 0; i < subjects.length; i++) {
			let e = subjects[i]
			if (e.conn === stream) {
				subjects.splice(i, 1)
				i--
			}
		}

		for (let i = 0; i < awaitingSubjects.length; i++) {
			let e = awaitingSubjects[i]
			if (e.conn === stream) {
				awaitingSubjects.splice(i, 1)
				i--
			}
		}
	}), stream)
})

server.listen(TEST_PORT, function (err) {
	if (err) return console.error(err)
	console.log('listening at http://localhost:' + TEST_PORT)
})
