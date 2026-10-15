"""Count sampled execution stacks inside otherwise unexplained callback spans."""
import json
import sys
from collections import Counter
from pathlib import Path

from report import accounting_segments, local_samples, section_spans


def sampled_callbacks(capture, start, spans, first_socket, ready):
    profile = capture['profile']
    nodes = {node['id']: node for node in profile['nodes']}
    parents = {child: node['id'] for node in profile['nodes'] for child in node.get('children', [])}
    counts = Counter()
    at = capture['origin'] - start
    for node_id, delta in zip(profile['samples'], profile['timeDeltas']):
        at += delta / 1000
        if not any(s['phase'] == 'callback' and s['start'] <= at < s['end'] for s in spans):
            continue
        group = 'Setup' if at < first_socket else 'Connection' if at < ready else 'Operation'
        stack = []
        while node_id in nodes:
            frame = nodes[node_id]['callFrame']
            stack.append((frame['functionName'] or '(anonymous)', frame['url'], frame['lineNumber'] + 1))
            node_id = parents.get(node_id)
        counts[group, tuple(stack)] += 1
    return [{'group': group, 'function': stack[0][0], 'url': stack[0][1], 'line': stack[0][2],
             'stack': [{'function': name, 'url': url, 'line': line} for name, url, line in stack],
             'samples': count} for (group, stack), count in counts.items()]


def summarize(data):
    samples = [s for s in data['samples'] if s['variant'] in ('native', 'serverless-no-monitoring')]
    counts = Counter()
    for sample, row in zip(samples, local_samples(data)):
        trace = sample['trace']
        sections = section_spans(row)
        for entry in sampled_callbacks(trace['cpuProfile'], trace['start'], accounting_segments(row['timeline']),
                                       sections[0]['end'], sections[-1]['start']):
            counts[entry['group'], json.dumps(entry['stack'], sort_keys=True)] += entry['samples']
    return {'createdAt': data['createdAt'], 'invocations': len(samples), 'samplingIntervalUs': 100,
            'scope': 'Separate local diagnostic run; sampled stacks within residual callback spans only',
            'stacks': [{'group': group, 'samples': count, 'stack': json.loads(stack)}
                       for (group, stack), count in counts.most_common()]}


if __name__ == '__main__':
    result = summarize(json.loads(Path(sys.argv[1]).read_text()))
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
