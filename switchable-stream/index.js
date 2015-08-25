/*
Basic idea:
Pass message indicating channel is open
Once a side has gotten its own call and notification from the other side, start sending data on the new channel
Add sequence numbers and framing



*/

var duplexify = require('duplexify')
var inherits = require('inherits')
var MultiStream = require('multistream')

var SwitchableStream = module.exports = function (initialStream) {
	var self = this
	duplexify.call(self)

	self._currentStream = null
	self._replacements = []
	self._waiting = []

	self._inStream = new MultiStream(function (cb) {
		if (self._replacements.length)
			cb(null, self._replacements.shift())
		else
			self._waiting.push(cb)
	})
	self.setReadable(self._inStream)

	self.replace(initialStream)
}

inherits(SwitchableStream, duplexify)

SwitchableStream.prototype.replace = function (newStream) {
	var self = this

	if (self._waiting.length)
		self._waiting.shift()(null, newStream)
	else
		self._replacements.push(newStream)

	self.setWritable(newStream)

	if (self._currentStream)
		self._currentStream.end()
	self._currentStream = newStream
}
