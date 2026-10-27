export class ProtocolLineLimitError extends Error {
  constructor() { super('Codex protocol line exceeded its byte limit.'); this.name = 'ProtocolLineLimitError'; }
}

export class BoundedLineDecoder {
  private readonly fragments: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly maxLineBytes: number;
  constructor(maxLineBytes: number) { this.maxLineBytes = maxLineBytes; }

  push(chunk: Buffer): readonly string[] {
    const lines: string[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (this.bufferedBytes + fragment.length > this.maxLineBytes) throw new ProtocolLineLimitError();
      if (fragment.length > 0) { this.fragments.push(fragment); this.bufferedBytes += fragment.length; }
      if (newline === -1) break;
      const line = Buffer.concat(this.fragments, this.bufferedBytes);
      const content = line.at(-1) === 13 ? line.subarray(0, -1) : line;
      lines.push(content.toString('utf8'));
      this.fragments.length = 0;
      this.bufferedBytes = 0;
      offset = newline + 1;
    }
    return lines;
  }
}
