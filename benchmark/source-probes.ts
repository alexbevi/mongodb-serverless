import { readFileSync, writeFileSync } from 'node:fs';

const probes: [string, string, string, 'sync' | 'async'][] = [
  ['node_modules/mongodb/lib/cmap/connect.js', 'parseSslOptions(options)', 'TLS options / IP validation', 'sync'],
  ['node_modules/mongodb/lib/cmap/connect.js', 'new ConnectionType(socket, options)', 'Connection object construction', 'sync'],
  ['node_modules/mongodb/lib/cmap/connect.js', 'await prepareHandshakeDocument(authContext)', 'Handshake preparation', 'async'],
  ['node_modules/mongodb/lib/sdam/topology.js', 'new server_1.Server(topology, serverDescription, topology.s.options)', 'Server object construction', 'sync'],
  ['node_modules/mongodb/lib/sdam/topology.js', 'topology.serverUpdateHandler(description)', 'Topology update', 'sync'],
  ['node_modules/mongodb/lib/sdam/server.js', 'operation.buildCommand(conn, session)', 'Command preparation', 'sync'],
  ['node_modules/mongodb/lib/sdam/server.js', 'operation.buildOptions(timeoutContext)', 'Command options', 'sync'],
  ['node_modules/mongodb/lib/operations/execute_operation.js', 'operation.handleOk(result)', 'Result processing', 'sync'],
  ['driver/dist/driver/src/clients.js', 'directUri(this.#options.uri, hostPort)', 'Direct URI rewrite', 'sync'],
  ['driver/dist/driver/src/clients.js', 'this.#options.createClient(uri, this.#options.driverOptions)', 'Native client construction', 'sync'],
  ['driver/dist/driver/src/clients.js', "import('./no-monitoring/index.js')", 'Load no-monitoring module', 'async'],
  ['driver/dist/driver/src/clients.js', 'disableMonitoring(client)', 'Activate no-monitoring patch', 'sync'],
  ['driver/dist/driver/src/clients.js', 'this.#options.plugin.read()', 'Read plugin topology', 'async'],
  ['node_modules/mongodb/lib/mongo_client.js', '(0, connection_string_1.parseOptions)(url, this, options)', 'Native URI/options parsing', 'sync'],
  ['node_modules/mongodb/lib/mongo_client.js', 'fs_1.promises.readFile(options.tlsCAFile)', 'Read TLS CA certificate', 'async'],
  ['node_modules/mongodb/lib/mongo_client.js', 'new topology_1.Topology(this, options.hosts, options)', 'Topology construction', 'sync'],
  ['node_modules/mongodb/lib/cmap/connect.js', 'options.metadata', 'Await handshake metadata', 'async'],
  ['node_modules/mongodb/lib/cmap/handshake/client_metadata.js', 'addContainerMetadata(metadataDocument.toObject())', 'Container metadata probe', 'async'],
  ['node_modules/mongodb/lib/cmap/handshake/client_metadata.js', 'await runtime', 'Load runtime adapter', 'async'],
];

for (const [file, expression, name, kind] of probes) {
  const source = readFileSync(file, 'utf8');
  const target = name === 'Await handshake metadata' ? 'await options.metadata' : name === 'TLS options / IP validation' ? 'tls.connect(parseSslOptions(options))' : expression;
  const value = name === 'Load runtime adapter' ? 'runtime' : expression.replace(/^await /, '');
  const prefix = target.startsWith('await ') ? 'await ' : '';

  if (source.split(target).length !== 2) throw new Error(`Re-verify probe ${name}: ${file}`);

  writeFileSync(file, source.replace(target,
    name === 'TLS options / IP validation'
      ? `tls.connect(globalThis.__benchmarkActivities.sync(${JSON.stringify(name)}, () => ${value}))`
      : `${prefix}globalThis.__benchmarkActivities.${kind}(${JSON.stringify(name)}, () => ${value})`));
}
