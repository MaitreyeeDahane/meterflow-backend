import { Queue } from 'bullmq';
import { getRedis } from '../config/redis';

const connection = () => getRedis();

// Create queues lazily to avoid connection before Redis is ready
let _usageQueue: Queue;
let _invoiceQueue: Queue;
let _alertQueue: Queue;
let _webhookQueue: Queue;
let _abuseQueue: Queue;
let _emailQueue: Queue;
let _exportQueue: Queue;
let _cleanupQueue: Queue;

const QUEUE_DEFAULTS = {
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2000 },
  },
};

export const usageQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_usageQueue) {
      _usageQueue = new Queue('usage-log', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_usageQueue as any)[prop];
  },
});

export const invoiceQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_invoiceQueue) {
      _invoiceQueue = new Queue('invoice-gen', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_invoiceQueue as any)[prop];
  },
});

export const alertQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_alertQueue) {
      _alertQueue = new Queue('alerts', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_alertQueue as any)[prop];
  },
});

export const webhookQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_webhookQueue) {
      _webhookQueue = new Queue('webhooks', {
        connection: connection(),
        defaultJobOptions: {
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      });
    }
    return (_webhookQueue as any)[prop];
  },
});

export const abuseQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_abuseQueue) {
      _abuseQueue = new Queue('abuse', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_abuseQueue as any)[prop];
  },
});

export const emailQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_emailQueue) {
      _emailQueue = new Queue('email', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_emailQueue as any)[prop];
  },
});

export const exportQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_exportQueue) {
      _exportQueue = new Queue('export', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_exportQueue as any)[prop];
  },
});

export const cleanupQueue = new Proxy({} as Queue, {
  get(_target, prop) {
    if (!_cleanupQueue) {
      _cleanupQueue = new Queue('cleanup', { connection: connection(), ...QUEUE_DEFAULTS });
    }
    return (_cleanupQueue as any)[prop];
  },
});

export function getAllQueues() {
  return [
    { name: 'usage-log', queue: _usageQueue },
    { name: 'invoice-gen', queue: _invoiceQueue },
    { name: 'alerts', queue: _alertQueue },
    { name: 'webhooks', queue: _webhookQueue },
    { name: 'abuse', queue: _abuseQueue },
    { name: 'email', queue: _emailQueue },
    { name: 'export', queue: _exportQueue },
    { name: 'cleanup', queue: _cleanupQueue },
  ].filter((q) => q.queue);
}
