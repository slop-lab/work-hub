#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } })}\n`);
    closeSync(0);
    setInterval(() => undefined, 1000);
    continue;
  }
}
