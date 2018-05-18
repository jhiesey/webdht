exports.remoteConnector = {
	hello: 'sync',
	onConnection: 'sync',
	globalerror: 'sync',

	connection: {
		stream: 'duplex',
		close: 'sync',
		direct: 'sync'
	}
}

exports.connector = {
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

exports.server = {
	subjectAvailable: 'duplex',
	getConnector: 'duplex'
}
