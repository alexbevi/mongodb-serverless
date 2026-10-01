// Stands in for a plugin whose own dependency is missing. Resolving this must
// report the plugin's failure, not claim the plugin itself is not installed.
import '@scope/definitely-not-installed';

export default class BrokenPlugin {}
