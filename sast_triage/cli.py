from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import click

from sast_triage.llm.client import TriageLLMClient
from sast_triage.memory.store import MemoryStore
from sast_triage.pipeline import TriagePipeline


@click.group()
@click.option("--verbose", "-v", is_flag=True)
def main(verbose):
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )


@main.command()
@click.argument("input_file", type=click.Path(exists=True), required=False)
@click.option("--model", default="o3-mini")
@click.option("--effort", default="medium", type=click.Choice(["low", "medium", "high"]))
@click.option("--base-url", default=None, help="Custom API base URL (e.g., OpenRouter)")
@click.option("--api-key", default=None, help="API key (or set OPENAI_API_KEY env)")
@click.option("--memory-db", default=None)
@click.option("--output", "-o", type=click.Path(), default=None)
@click.option("--no-llm", is_flag=True)
def triage(input_file, model, effort, base_url, api_key, memory_db, output, no_llm):
    if input_file:
        raw = Path(input_file).read_text()
    else:
        raw = sys.stdin.read()

    data = json.loads(raw)

    llm_client = None if no_llm else TriageLLMClient(
        model=model, reasoning_effort=effort, base_url=base_url, api_key=api_key,
    )
    memory = MemoryStore(db_path=memory_db) if memory_db else None

    pipeline = TriagePipeline(llm_client=llm_client, memory=memory)
    results = pipeline.run(data)

    output_data = [r.to_dict() for r in results]
    text = json.dumps(output_data, indent=2)

    if output:
        Path(output).write_text(text)
        click.echo(f"Results written to {output}")
    else:
        click.echo(text)

    if memory:
        memory.close()


@main.command()
@click.argument("fingerprint")
@click.argument("feedback_text")
@click.option("--memory-db", default=None)
def feedback(fingerprint, feedback_text, memory_db):
    memory = MemoryStore(db_path=memory_db) if memory_db else MemoryStore()
    success = memory.add_feedback(fingerprint, feedback_text)
    memory.close()
    if success:
        click.echo(f"Feedback recorded for {fingerprint}")
    else:
        click.echo(f"No record found for fingerprint {fingerprint}", err=True)
        sys.exit(1)
