Architecture:

* Nodes have id and zero or more urls

Connector:
* connectTo url or connectTo id, relay

We should test this independently!


A <---> B <---> C

A sends to B: connectTo C
B sends to C: connectFrom A

TODO:
* support multiple binding addresses/ports
* testing framework for browsers:

keep track of all nodes/edges in graph.
randomly choose edges to open
log successes and failures


Events:
* new node
* new indirect connection
* new direct connection

// or maybe the driver does this?
this.emit('debug', 'newnode')
this.emit('debug', 'connected')
this.emit('')

TestHarness object is created, which establishes websocket connection to server
Then creates node, and listens for commands, then spits events back to server





Simplest test:
* choose node randomly
* choose neighbor of that node randomly
* create connection


High level API:
* find and/or advertise *topic*
	topic(id, advertise?, numPeers)



* find peer
	peer(id)

* open stream
	stream(connection, name)

* listen for stream; call callback on return
	listen(name)


MINIMAL:
* open stream to specific node
* open stream to node(s) advertising topic
* advertise topic
* listen for stream
