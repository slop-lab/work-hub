import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { Hub } from '../application/orchestration/hub.ts';

class BenchmarkError extends Error {}
const count = z.coerce.number().int().min(1).max(100_000).parse(process.env['BENCH_TASKS'] ?? '10000');
const directory = mkdtempSync(join(tmpdir(), 'work-hub-benchmark-'));
const hub = new Hub(join(directory, 'hub.sqlite'));
try {
  const actor = hub.actorForUser('user-admin');
  if (!actor) throw new BenchmarkError('Bootstrap administrator is unavailable.');
  const acceptance: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const receipt = await hub.execute(actor, { commandId: `benchmark-${index}`, type: 'task.create', payload: { projectId: 'project-default', title: `Benchmark work item ${index}` } });
    if (receipt.status !== 'confirmed') throw new BenchmarkError(`Capture refused at ${index}: ${receipt.error?.code}`);
    acceptance.push(performance.now() - started);
  }
  const reads: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    const snapshot = hub.snapshot(actor);
    if (snapshot.tasks.length !== count) throw new BenchmarkError('Snapshot omitted benchmark records.');
    reads.push(performance.now() - started);
  }
  const percentile = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  console.log(JSON.stringify({ node: process.version, visibleParallelism: availableParallelism(), visibleMemoryGiB: totalmem() / 1024 ** 3, tasks: count, sampleReads: reads.length, localCommandAcceptanceP95Ms: percentile(acceptance), fullSnapshotP95Ms: percentile(reads), note: 'Isolated SQLite capture/read measurement only. Not the full 20-session/100-event-per-second target envelope or a production benchmark.' }, null, 2));
} finally {
  hub.close();
  rmSync(directory, { recursive: true });
}
