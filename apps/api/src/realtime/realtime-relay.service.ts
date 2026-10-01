import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { Prisma } from '../generated/prisma/client';
import { OutboxMessageStatus } from '../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import type { RealtimeTopic } from '@pulse-field/contracts';
import {
  FULFILLMENT_INVALIDATED_EVENT,
  INVENTORY_INVALIDATED_EVENT,
  REALTIME_EVENT_VERSION,
  TRANSFER_INVALIDATED_EVENT,
} from './realtime.events';
import { RealtimeGateway } from './realtime.gateway';
import { REALTIME_PROFILE } from './realtime.tokens';

const TYPES = [
  INVENTORY_INVALIDATED_EVENT,
  TRANSFER_INVALIDATED_EVENT,
  FULFILLMENT_INVALIDATED_EVENT,
];
const POLL_MS = 1000,
  LEASE_MS = 30_000,
  MAX_ATTEMPTS = 8;
type Claimed = {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateId: string;
  aggregateType: string;
  payload: unknown;
  attemptCount: number;
};

export function topicsFor(type: string, aggregateType: string): RealtimeTopic[] {
  if (type === INVENTORY_INVALIDATED_EVENT && aggregateType === 'inventory-threshold')
    return ['inventory', 'low-stock', 'inventory-reconciliation'];
  if (type === INVENTORY_INVALIDATED_EVENT)
    return ['inventory', 'low-stock', 'inventory-reconciliation', 'catalog'];
  if (type === TRANSFER_INVALIDATED_EVENT && aggregateType === 'inventory-transfer')
    return ['transfers'];
  if (type === TRANSFER_INVALIDATED_EVENT)
    return ['transfers', 'inventory', 'low-stock', 'inventory-reconciliation'];
  return ['fulfillment'];
}
function valid(message: Claimed): boolean {
  if (
    !TYPES.includes(message.eventType as (typeof TYPES)[number]) ||
    message.eventVersion !== REALTIME_EVENT_VERSION ||
    !message.payload ||
    typeof message.payload !== 'object' ||
    Array.isArray(message.payload)
  )
    return false;
  const payload = message.payload as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.resourceId === message.aggregateId &&
    Number.isSafeInteger(payload.resourceVersion) &&
    Number(payload.resourceVersion) > 0
  );
}

@Injectable()
export class RealtimeRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeRelayService.name);
  private readonly relayId = `realtime:${randomUUID()}`;
  private readonly channel: string;
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private timer?: NodeJS.Timeout;
  private polling = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    @Inject(REALTIME_PROFILE) profile: LocalProfile,
  ) {
    this.channel = `pulse-field:realtime:v1:${createHash('sha256').update(profile.DATABASE_URL).digest('hex').slice(0, 24)}`;
    const options = {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: null,
    };
    this.publisher = new Redis(profile.EPHEMERAL_REDIS_URL, options);
    this.subscriber = new Redis(profile.EPHEMERAL_REDIS_URL, options);
    this.publisher.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
  }
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.subscriber.subscribe(this.channel);
      this.subscriber.on('message', (channel, body) => {
        if (channel === this.channel) this.receive(body);
      });
    } catch {
      this.logger.error('Realtime subscriber unavailable.');
    }
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
    void this.poll();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.publisher.disconnect(false);
    this.subscriber.disconnect(false);
  }
  async drainOnce(): Promise<boolean> {
    const item = await this.claim();
    if (!item) return false;
    await this.dispatch(item);
    return true;
  }

  async diagnostics(): Promise<{
    connections: number;
    publisherAvailable: boolean;
    subscriberAvailable: boolean;
    pending: number;
    deadLetters: number;
    oldestPendingAgeSeconds: number | null;
    lastPublishedAt: string | null;
  }> {
    const [pending, deadLetters, oldest, published] = await Promise.all([
      this.prisma.outboxMessage.count({
        where: { status: OutboxMessageStatus.PENDING, eventType: { in: TYPES } },
      }),
      this.prisma.outboxMessage.count({
        where: { status: OutboxMessageStatus.DEAD_LETTER, eventType: { in: TYPES } },
      }),
      this.prisma.outboxMessage.findFirst({
        where: { status: OutboxMessageStatus.PENDING, eventType: { in: TYPES } },
        orderBy: { occurredAt: 'asc' }, select: { occurredAt: true },
      }),
      this.prisma.outboxMessage.findFirst({
        where: { status: OutboxMessageStatus.PUBLISHED, eventType: { in: TYPES } },
        orderBy: { publishedAt: 'desc' }, select: { publishedAt: true },
      }),
    ]);
    return {
      connections: this.gateway.connectionCount(),
      publisherAvailable: this.publisher.status === 'ready',
      subscriberAvailable: this.subscriber.status === 'ready',
      pending,
      deadLetters,
      oldestPendingAgeSeconds: oldest
        ? Math.max(0, Math.floor((Date.now() - oldest.occurredAt.getTime()) / 1000))
        : null,
      lastPublishedAt: published?.publishedAt?.toISOString() ?? null,
    };
  }
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.drainOnce();
    } catch {
      this.logger.error('Realtime relay poll failed.');
    } finally {
      this.polling = false;
    }
  }
  private async claim(): Promise<Claimed | null> {
    const now = new Date(),
      stale = new Date(now.getTime() - LEASE_MS);
    const where: Prisma.OutboxMessageWhereInput = {
      status: OutboxMessageStatus.PENDING,
      eventType: { in: TYPES },
      availableAt: { lte: now },
      OR: [{ claimedAt: null }, { claimedAt: { lte: stale } }],
    };
    const item = await this.prisma.outboxMessage.findFirst({
      where,
      orderBy: [{ availableAt: 'asc' }, { occurredAt: 'asc' }],
      select: {
        id: true,
        eventType: true,
        eventVersion: true,
      aggregateId: true,
      aggregateType: true,
        payload: true,
        attemptCount: true,
      },
    });
    if (!item) return null;
    const updated = await this.prisma.outboxMessage.updateMany({
      where: { id: item.id, ...where },
      data: { claimedAt: now, claimedBy: this.relayId },
    });
    return updated.count === 1 ? item : null;
  }
  private async dispatch(item: Claimed): Promise<void> {
    if (!valid(item)) return this.deadLetter(item.id, 'INVALID_REALTIME_EVENT');
    try {
      await this.publisher.publish(
        this.channel,
        JSON.stringify({ version: 1, topics: topicsFor(item.eventType, item.aggregateType) }),
      );
      await this.published(item.id);
    } catch {
      await this.retry(item);
    }
  }
  private receive(body: string): void {
    try {
      const value: unknown = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const topics = Reflect.get(value, 'topics');
      if (
        !Array.isArray(topics) ||
        !topics.every((topic) =>
          [
            'catalog',
            'fulfillment',
            'inventory',
            'transfers',
            'low-stock',
            'inventory-reconciliation',
          ].includes(String(topic)),
        )
      )
        return;
      this.gateway.publish(topics as RealtimeTopic[]);
    } catch {
      /* Redis input is untrusted transport data. */
    }
  }
  private async published(id: string): Promise<void> {
    await this.prisma.outboxMessage.updateMany({
      where: { id, status: OutboxMessageStatus.PENDING, claimedBy: this.relayId },
      data: {
        status: OutboxMessageStatus.PUBLISHED,
        publishedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        lastError: null,
      },
    });
  }
  private async deadLetter(id: string, code: string): Promise<void> {
    await this.prisma.outboxMessage.updateMany({
      where: { id, status: OutboxMessageStatus.PENDING, claimedBy: this.relayId },
      data: {
        status: OutboxMessageStatus.DEAD_LETTER,
        attemptCount: { increment: 1 },
        lastError: code,
        deadLetteredAt: new Date(),
        claimedAt: null,
        claimedBy: null,
      },
    });
  }
  private async retry(item: Claimed): Promise<void> {
    const attempts = item.attemptCount + 1;
    if (attempts >= MAX_ATTEMPTS) return this.deadLetter(item.id, 'REALTIME_PUBLICATION_FAILED');
    await this.prisma.outboxMessage.updateMany({
      where: { id: item.id, status: OutboxMessageStatus.PENDING, claimedBy: this.relayId },
      data: {
        attemptCount: attempts,
        lastError: 'REALTIME_PUBLICATION_FAILED',
        availableAt: new Date(Date.now() + Math.min(1000 * 2 ** (attempts - 1), 300000)),
        claimedAt: null,
        claimedBy: null,
      },
    });
  }
}
