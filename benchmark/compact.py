"""Store repeated execution stacks once without discarding timing evidence."""
import argparse
import json
from pathlib import Path


def compact_sources(data):
    if 'diagnosticEncoding' in data:
        return
    sources = data.setdefault("executionSources", [])
    ids = {source: index for index, source in enumerate(sources)}
    for sample in data["samples"]:
        for segment in sample["trace"].get("execution", {}).get("segments", []):
            if "source" not in segment:
                continue
            source = segment.pop("source")
            if source not in ids:
                ids[source] = len(sources)
                sources.append(source)
            segment["sourceId"] = ids[source]


def diagnostic_streams(data):
    for sample in data['samples']:
        trace = sample['trace']
        yield trace.get('activities', []), trace.get('execution', {}).get('segments', [])


def compact_diagnostics(data):
    if 'diagnosticEncoding' in data:
        return
    streams = list(diagnostic_streams(data))
    columns = [list(dict.fromkeys(key for pair in streams for record in pair[index] for key in record)) for index in [0, 1]]
    for pair in streams:
        for records, fields in zip(pair, columns):
            for index, record in enumerate(records):
                mask = sum(1 << bit for bit, field in enumerate(fields) if field in record)
                records[index] = [mask, *[record[field] for field in fields if field in record]]
    data['diagnosticEncoding'] = dict(version=1, format='presence mask followed by values in column order',
                                      activities=columns[0], execution=columns[1])


def expand_diagnostics(data):
    encoding = data.pop('diagnosticEncoding', None)
    if encoding is None:
        return
    if encoding['version'] != 1:
        raise ValueError('Unsupported diagnostic encoding')
    for pair in diagnostic_streams(data):
        for records, fields in zip(pair, [encoding['activities'], encoding['execution']]):
            for index, record in enumerate(records):
                values = iter(record[1:])
                records[index] = {field: next(values) for bit, field in enumerate(fields) if record[0] & (1 << bit)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path)
    parser.add_argument("--diagnostics", action="store_true")
    arguments = parser.parse_args()
    data = json.loads(arguments.samples.read_text())
    if arguments.diagnostics:
        compact_sources(data)
        compact_diagnostics(data)
    else:
        compact_sources(data)
    arguments.samples.write_text(json.dumps(data, separators=(",", ":")) + "\n")
