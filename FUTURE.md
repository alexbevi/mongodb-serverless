# Ideas for the Future

1. DNS Based Topology 
Why doesn't the cluster advertise the current primary on a dedicated DNS that updates its IP when the primary election occurs?

This way, clients could avoid the replica set based discovery, and perform a parallel SRV+TXT member discovery and primary host resolution discovery. 

It wouldn't tell you everything about the cluster, but would allow for cases like ours to directly connect exactly once to the member required. 

Of course there would be some DNS TTL delay, but we could accept that as a limitation of this model, and fall back to using getReplsetStatus, or just wait out the TTL.


