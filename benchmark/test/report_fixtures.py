"""Synthetic traces for the diagnostic report, independent of measured results."""
from copy import deepcopy
import importlib.util
from pathlib import Path


def local_data():
    samples = []
    for operation in ['read', 'write']:
        for variant in ['native', 'serverless-no-monitoring']:
            for iteration in range(2):
                native = variant == 'native'
                start, end = 100, (200 if native else 165) + iteration
                selected = 'a' if operation == 'read' else 'b'
                def socket(host, begin, application=False):
                    result = dict(host=host, port=27017, start=begin,
                                  role='PRIMARY' if host == 'b' else 'SECONDARY',
                                  lookup=[begin+1, begin+3], tcp=[begin+3, begin+6],
                                  tls=[begin+6, begin+16], hello=[begin+17, begin+22])
                    if application:
                        result['auth'] = [begin+23, begin+29]
                    return result
                application = socket(selected, 145 if native else 110, True)
                sockets = [socket(host, 110+i) for i, host in enumerate(['a', 'b', 'c'])] if native else []
                sockets.append(application)
                command = dict(name='find' if operation == 'read' else 'update', start=end-10,
                               sent=end-9, end=end-3, connectionId=1, socket=application)
                ready = application['auth'][1]+1
                durations = {phase: application[phase][1]-application[phase][0] for phase in ['lookup','tcp','tls','hello','auth']}
                durations.update(send=1, receive=6)
                durations.update(total=end-start, other=end-start-sum(durations.values()))
                trace = dict(start=start, end=end, sockets=sockets, command=command,
                    dns=[dict(kind='SRV', start=103, end=108), dict(kind='TXT', start=104, end=107)] if native else [],
                    lifecycle=dict(connectionSetup=[application['start'],ready], checkouts=[[application['start']-1,ready+1]],
                                   readyToCommand=[ready,command['start']], command=[command['start'],command['end']], afterCommand=[command['end'],end]),
                    activities=[dict(name='Native URI/options parsing',kind='sync',start=100,end=102,threadCpuMs=1)],
                    execution=dict(start=start,end=end,threadCpuMs=10,segments=[dict(kind='callback',start=start,end=end,threadCpuMs=10)]))
                samples.append(dict(variant=variant, operation=operation, iteration=iteration, batch=1,
                                    servedRole=application['role'], timings=durations, applicationConnectionReadyMs=ready-start, trace=trace))
    return dict(createdAt='2000-01-01', configuration=dict(diagnostics=True,count=2,noMonitoringComparison=True),
                environment=dict(host={},docker='{"Arch":"arm64"}',cpuMax='max 100000',memoryMax=str(1024**3)),samples=samples)


def aws_data():
    data = local_data()
    spec = importlib.util.spec_from_file_location('fixture_report', Path(__file__).parents[1] / 'report.py')
    report = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(report)
    rows = report.local_samples(data)
    samples = []
    for sample, row in zip(data['samples'], rows):
        value = deepcopy(sample)
        value.update(mode=row['mode'], phases=value['timings'], timeline=row['timeline'], block=row['block'])
        samples.append(value)
    return dict(recordedAt='2000-01-01', region='ap-southeast-2', architecture='arm64', memoryMB=1769,
                configuration=dict(diagnostics=True),samples=samples)
