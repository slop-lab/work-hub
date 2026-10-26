import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { HubError } from '../domain/errors.ts';

export function readPrivateConfiguration(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 || stat.size > 64 * 1024) throw new HubError({ code: 'connection_file_private', category: 'authorization',
      message: 'Connection configuration must be a private 0600 user-owned regular file, at most 64 KiB.', retry: 'manual_action' });
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
