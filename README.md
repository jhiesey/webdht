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