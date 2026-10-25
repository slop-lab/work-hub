import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug'),
  redact: ['req.headers.authorization', 'req.headers.cookie', 'token', 'scope', 'secret', 'password'],
  base: { service: 'work-hub' },
});
