"""Synthetic event traces shaped like the worker's output. No recorded measurements."""
import copy

VARIANTS = ['native', 'no-plugin', 'ssm', 'ssm-uncached']


def application(start, host='member-1', role='PRIMARY'):
    return {'kind': 'application', 'host': host, 'port': 27017, 'start': start, 'role': role,
            'lookup': [start, start + 1], 'tcp': [start + 1, start + 3], 'tls': [start + 3, start + 10],
            'hello': [start + 10, start + 13], 'auth': [start + 13, start + 20], 'authorized': True}


def monitor(start, host):
    return {'kind': 'monitor', 'host': host, 'port': 27017, 'start': start, 'role': 'SECONDARY',
            'lookup': [start, start + 1], 'tcp': [start + 1, start + 3], 'tls': [start + 3, start + 10],
            'hello': [start + 10, start + 13]}


def sample(variant, operation, iteration=0, total=100.0, two_connections=False):
    """A cold sample starting at t=1000: setup, optional monitors, connection, command, remainder."""
    base = 1000.0
    sockets = []
    commands = []
    ssm = []
    if variant == 'native':
        sockets += [monitor(base + 10, f'member-{n}') for n in (1, 2, 3)]
        connect = base + 25
    else:
        connect = base + 10
    if two_connections:
        first = application(connect, 'member-2', 'SECONDARY')
        sockets.append(first)
        commands.append({'name': 'replSetGetStatus', 'start': connect + 21, 'end': connect + 24, 'socket': first})
        connect += 25
    selected = application(connect)
    sockets.append(selected)
    command = {'name': 'find' if operation == 'read' else 'update', 'start': connect + 22, 'end': connect + 25, 'socket': selected}
    commands.append(command)
    if variant == 'ssm-uncached':
        ssm.append({'command': 'PutParameterCommand', 'start': connect + 26, 'end': connect + 30, 'attempts': 1})
    trace = {'start': base, 'end': base + total, 'sockets': sockets,
             'commands': commands, 'command': command, 'checkouts': [{'address': 'member-1:27017', 'start': connect - 1, 'end': connect + 22}], 'ssm': ssm}
    application_sockets = [s for s in sockets if s['kind'] == 'application']
    return {'variant': variant, 'operation': operation, 'iteration': iteration, 'totalMs': total,
            'verified': True, 'cold': True, 'sockets': len(sockets), 'authenticatedSockets': len(application_sockets),
            'monitorSockets': len(sockets) - len(application_sockets), 'servedRole': 'PRIMARY',
            'seedRole': application_sockets[0]['role'], 'ssmMs': 5.0, 'ssmPhase': 'init', 'nodeVersion': 'v24.0.0',
            'lambda': {'initMs': 50.0, 'initSource': 'node-process-clock'}, 'trace': trace}


def run(count=4, totals=None):
    """A complete run; `totals` maps (variant, operation) to each sample's handler time."""
    totals = totals or {}
    samples = []
    for iteration in range(count):
        for operation in ('read', 'write'):
            for variant in VARIANTS:
                total = totals.get((variant, operation), 100.0)
                two = variant == 'no-plugin' and operation == 'write' and iteration % 2 == 1
                samples.append(sample(variant, operation, iteration, total, two))
    return {'createdAt': '2026-10-24T00:00:00Z', 'failures': [], 'samples': copy.deepcopy(samples),
            'configuration': {'count': count, 'variants': VARIANTS, 'environment': 'Local Docker', 'overview': 'handler'}}
