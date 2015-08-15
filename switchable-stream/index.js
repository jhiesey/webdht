/*
Basic idea:
Pass message indicating channel is open
Once a side has gotten its own call and notification from the other side, start sending data on the new channel
Add sequence numbers and framing



*/

var duplexify = require('duplexify')
var inherits = require('inherits')
var through2 = require('through2')


var SwitchableStream = module.exports = function (initialStream) {
	var self = this
	duplexify.call(self)

	self._inBuffer = null

	if (initialStream)
		self.replace(initialStream)
}

inherits(SwitchableStream, duplexify)

SwitchableStream.prototype.replace = function (newStream) {
	var self = this

	self._switchingTo = newStream

	if (!self._out) {
		self._switchWrite(false)
		self._switchRead()
		return
	}

	// send replaceWrite
	var header = new Buffer(1)
	header.writeUInt8(1)
	self._out.push(header)

	if (self._gotReplaceWrite)
		self._switchWrite(true)
}

SwitchableStream.prototype._switchWrite = function (trueSwitch) {
	var self = this

	if (trueSwitch) {
		// send replaceRead
		var header = new Buffer(1)
		header.writeUInt8(2)
		self._out.push(header)
	}

	self._out = through2(function (chunk, enc, cb) {
		self._outFilter(this, chunk, enc, cb)
	})

	self._switchedDuplex = duplexify()
	self._switchedDuplex.setReadable(self._out)
	self._switchedDuplex.pipe(self._switchingTo).pipe(self._switchedDuplex)

	self.setWritable(self._out)

	self._gotReplaceWrite = false
	self._switchingTo = null
}

SwitchableStream.prototype._switchRead = function () {
	var self = this
	self._in = through2(function (chunk, enc, cb) {
		self._inFilter(this, chunk, enc, cb)
	})

	self._switchedDuplex.setWritable(self._in)

	self.setReadable(self._in)
}

SwitchableStream.prototype._outFilter = function (stream, chunk, enc, cb) {
	var self = this

	// Add 5 bytes
	var header = new Buffer(5)
	header.writeUInt8(0, 0)
	header.writeUInt32BE(chunk.length, 1)
	stream.push(header)
	stream.push(chunk)

	cb()
}

SwitchableStream.prototype._inFilter = function (stream, chunk, enc, cb) {
	var self = this

	var buf
	if (self._inData)
		buf = Buffer.concat(self._inData, chunk)
	else
		buf = chunk

	while (true) {
		if (buf.length) {
			self._inData = buf
		} else {
			self._inData = null
			cb()
			return
		}

		var msgType = buf.readUInt8(0)
		switch(msgType) {
			case 0:
				if (buf.length < 5) {
					cb()
					return
				}
				var len = buf.readUInt32BE(1)
				if (buf.length < len + 5) {
					cb()
					return
				}
				stream.push(buf.slice(5, len + 5))
				buf = buf.slice(len + 5)
				break

			case 1:
				buf = buf.slice(1)
				self._gotReplaceWrite = true
				if (self._switchingTo)
					self._switchWrite(true)
				break

			case 2:
				buf = buf.slice(1)
				self._switchRead()
				break
			default:
				cb(new Error('Unexpected message type:', msgType))
		}
	}
}
