"""Store repeated execution stacks once without discarding timing evidence."""
import argparse
import json
from pathlib import Path


def compact_sources(data):
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path)
    arguments = parser.parse_args()
    data = json.loads(arguments.samples.read_text())
    compact_sources(data)
    arguments.samples.write_text(json.dumps(data, separators=(",", ":")) + "\n")
