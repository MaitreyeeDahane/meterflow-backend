import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import Redis from 'ioredis';
import { env } from '../config/env';
import { verifyAccessToken } from '../utils/jwt';

let io: SocketServer;

/**
 * Create a correctly-configured Redis subscriber.
 * Uses the same REDIS_URL as the main client — works with Upstash TLS (rediss://).
 */
function createSubscriber(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,      // subscribers must not retry inline
    enableReadyCheck: false,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

export function initSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: env.APP_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Auth middleware for Socket.io connections
  io.use(async (socket: Socket, next) => {
    const token =
      (socket.handshake.auth as Record<string, string>)?.token ||
      socket.handshake.headers.authorization?.slice(7);

    if (!token) return next(new Error('Authentication required'));

    const payload = await verifyAccessToken(token);
    if (!payload) return next(new Error('Invalid token'));

    (socket as Socket & { user: typeof payload; workspaceId: string }).user = payload;
    (socket as Socket & { workspaceId: string }).workspaceId = payload.workspaceId ?? '';
    next();
  });

  io.on('connection', (socket: Socket) => {
    const workspaceId = (socket as Socket & { workspaceId: string }).workspaceId;
    if (!workspaceId) { socket.disconnect(); return; }

    socket.join(`workspace:${workspaceId}`);
    console.log(`[Socket] Client connected → workspace:${workspaceId}`);

    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected ← workspace:${workspaceId}`);
    });
  });

  // Redis pub/sub — properly configured subscriber (not a duplicate of main client)
  const subscriber = createSubscriber();

  subscriber.on('error', (err) => console.error('[Socket] Redis subscriber error:', err.message));

  subscriber.psubscribe('ws:usage:*', (err) => {
    if (err) console.error('[Socket] psubscribe error:', err);
    else console.log('[Socket] Subscribed to ws:usage:* channel');
  });

  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const workspaceId = channel.split(':')[2];
    if (!workspaceId || !io) return;
    try {
      const data = JSON.parse(message) as Record<string, unknown>;
      io.to(`workspace:${workspaceId}`).emit('usage:event', data);
    } catch { /* ignore parse errors */ }
  });

  console.log('✅ Socket.io server initialized');
  return io;
}

export function emitToWorkspace(workspaceId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`workspace:${workspaceId}`).emit(event, data);
}

export function getIo(): SocketServer {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}
