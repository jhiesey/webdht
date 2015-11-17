

/*
Emits 'ready' when ready to go!


Must keep track of usage of connections
*/

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

// If there are at least this many nodes, always start queries
var MIN_BOOTSTRAP = 3

var ConnectionCache = module.exports = function (connector, bootstrapUrls) {
	var self = this

	self._connector = connector
	bootstrapUrls = bootstrapUrls || []

	var numToBootsrap = Math.max(Math.min(bootstrapUrls.length / 2, MIN_BOOTSTRAP), 1)
	bootstrapUrls.forEach(function (url) {
		self._connector.connectTo({
			url: url
		}, function (err) {
			if (err)
				return
			if (--numToBootsrap <= 0) {
				process.nextTick(function () {
					self.emit('ready')
				})
			}
		})
	})
}

inherits(ConnectionCache, EventEmitter)

ConnectionCache.prototype.add = function () {

}