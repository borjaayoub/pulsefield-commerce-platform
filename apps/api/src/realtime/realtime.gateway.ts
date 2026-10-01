import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { LocalProfile } from '@pulse-field/foundation';
import { randomBytes } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { RoleName } from '../generated/prisma/enums';
import { SessionService } from '../identity/session.service';
import { SESSION_COOKIE_NAME } from '../identity/identity.constants';
import { REALTIME_PROFILE } from './realtime.tokens';
import type { RealtimeTopic } from '@pulse-field/contracts';

type Audience = 'public' | 'staff';
type Client = Socket & {
  data: {
    audience?: Audience;
    sessionId?: string;
    streamId?: string;
    sequence?: number;
    pending?: Set<RealtimeTopic>;
    timer?: NodeJS.Timeout;
  };
};
const STAFF_TOPICS: RealtimeTopic[] = [
  'fulfillment',
  'inventory',
  'transfers',
  'low-stock',
  'inventory-reconciliation',
];

function cookieValue(value: string | undefined, name: string): string | undefined {
  return value
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

@WebSocketGateway({
  namespace: '/realtime',
  path: '/api/v1/realtime/socket.io',
  transports: ['websocket'],
  maxHttpBufferSize: 4096,
  cors: false,
})
@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly clients = new Set<Client>();
  constructor(
    @Inject(REALTIME_PROFILE) private readonly profile: LocalProfile,
    private readonly sessions: SessionService,
  ) {}

  async handleConnection(client: Client): Promise<void> {
    try {
      if (client.handshake.headers.origin !== this.profile.WEB_ORIGIN || this.clients.size >= 100) {
        client.disconnect(true);
        return;
      }
      const auth = client.handshake.auth;
      if (
        !auth ||
        typeof auth !== 'object' ||
        Object.keys(auth).length !== 1 ||
        !['public', 'staff'].includes(String(Reflect.get(auth, 'audience')))
      ) {
        client.disconnect(true);
        return;
      }
      const audience = Reflect.get(auth, 'audience') as Audience;
      if (audience === 'staff') {
        const sessionId = cookieValue(client.handshake.headers.cookie, SESSION_COOKIE_NAME);
        if (!sessionId || !(await this.canReceiveStaff(sessionId))) {
          client.disconnect(true);
          return;
        }
        client.data.sessionId = sessionId;
      }
      client.data.audience = audience;
      client.data.streamId = randomBytes(18).toString('base64url');
      client.data.sequence = 0;
      this.clients.add(client);
      client.emit('resync', { version: 1 });
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Client): void {
    this.clients.delete(client);
    if (client.data.timer) clearTimeout(client.data.timer);
  }

  publish(topics: RealtimeTopic[]): void {
    for (const client of this.clients) {
      const allowed = topics.filter(
        (topic) =>
          topic === 'catalog' || (client.data.audience === 'staff' && STAFF_TOPICS.includes(topic)),
      );
      if (!allowed.length) continue;
      const pending = client.data.pending ?? new Set<RealtimeTopic>();
      allowed.forEach((topic) => pending.add(topic));
      client.data.pending = pending;
      if (!client.data.timer) client.data.timer = setTimeout(() => void this.flush(client), 250);
    }
  }

  resyncAll(): void {
    for (const client of this.clients) client.emit('resync', { version: 1 });
  }
  connectionCount(): number {
    return this.clients.size;
  }

  private async flush(client: Client): Promise<void> {
    client.data.timer = undefined;
    const topics = [...(client.data.pending ?? [])];
    client.data.pending?.clear();
    if (!topics.length || !client.connected) return;
    let permitted = topics;
    if (client.data.audience === 'staff') {
      const capability = client.data.sessionId
        ? await this.staffCapability(client.data.sessionId)
        : null;
      if (!capability) {
        client.disconnect(true);
        return;
      }
      permitted = capability.includes(RoleName.ADMINISTRATOR)
        ? topics
        : topics.filter((topic) => topic === 'fulfillment');
    }
    if (permitted.length)
      client.emit('invalidate', {
        version: 1,
        streamId: client.data.streamId,
        sequence: (client.data.sequence = (client.data.sequence ?? 0) + 1),
        topics: permitted,
      });
  }

  private async staffCapability(sessionId: string): Promise<RoleName[] | null> {
    try {
      const capability = await this.sessions.currentCapability(sessionId);
      return capability.roles.includes(RoleName.ADMINISTRATOR) ||
        capability.roles.includes(RoleName.FULFILLER)
        ? capability.roles
        : null;
    } catch {
      return null;
    }
  }
  private async canReceiveStaff(sessionId: string): Promise<boolean> {
    return (await this.staffCapability(sessionId)) !== null;
  }
  onModuleDestroy(): void {
    this.logger.debug('Realtime gateway stopped.');
  }
}
