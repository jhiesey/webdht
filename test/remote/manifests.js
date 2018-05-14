exports.server = {
	hello: 'sync',
	onConnection: 'sync',
	globalerror: 'sync',

	connection: {
		stream: 'duplex',
		close: 'sync',
		direct: 'sync'
	}
}

exports.client = {
	createConnector: 'sync',
	connector: {
		destroy: 'sync',
		connectTo: 'async',
		connection: {
			openStream: 'duplex',
			close: 'sync',
			upgrade: 'async'
		}
	}
}
