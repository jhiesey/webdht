exports.remoteOverlay = {
	onStream: 'duplex',
	onError: 'sync'
}

exports.overlay = {
	createOverlay: 'async',
	openStream: 'duplex'
}

exports.server = {
	// from overlay
	overlay: {
		subjectAvailable: 'sync',
		onStream: 'duplex'
	},

	// from remote
	remote: {
		openStream: 'duplex',
		getOverlay: 'async'
	}
}