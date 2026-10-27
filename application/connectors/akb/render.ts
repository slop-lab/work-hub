import type { AkbBlock, AkbPage } from './schema.ts';

export function renderAkbPage(page: AkbPage): string {
  return page.document.blocks.flatMap(renderBlock).filter((line) => line.length > 0).join('\n\n');
}

function renderBlock(block: AkbBlock): readonly string[] {
  const children = block.children.flatMap(renderBlock);
  switch (block.type) {
    case 'heading': return [`${'#'.repeat(block.level ?? 1)} ${block.text}`, ...children];
    case 'list_item': return [`- ${block.text}`, ...children];
    case 'code': return [`\`\`\`${block.language ?? ''}\n${block.text}\n\`\`\``, ...children];
    case 'quote': return [`> ${block.text}`, ...children];
    case 'entity_embed': return [`${block.text} [AKB entity: ${block.entityId ?? 'unresolved'}]`, ...children];
    case 'artifact_embed': return [`${block.text} [AKB artifact: ${block.artifactId ?? 'unresolved'}]`, ...children];
    case 'paragraph':
    case 'list':
    case 'table':
    case 'callout':
      return [block.text, ...children];
    default: return assertNever(block.type);
  }
}

function assertNever(value: never): never { throw new TypeError(`Unexpected AKB block type ${String(value)}`); }
