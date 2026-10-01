'use client';

import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { isRealtimeInvalidationEnvelope, type RealtimeTopic } from '@pulse-field/contracts';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** Realtime is a refresh hint only; REST remains the authoritative projection. */
export function useRealtimeInvalidation(
  audience: 'public' | 'staff',
  onTopics: (topics: RealtimeTopic[]) => void,
): void {
  useEffect(() => {
    let sequence = 0;
    let streamId = '';
    const socket = io(`${API_ORIGIN}/realtime`, {
      path: '/api/v1/realtime/socket.io',
      transports: ['websocket'],
      withCredentials: true,
      auth: { audience },
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socket.on('resync', () =>
      onTopics(
        audience === 'public'
          ? ['catalog']
          : ['fulfillment', 'inventory', 'transfers', 'low-stock', 'inventory-reconciliation'],
      ),
    );
    socket.on('invalidate', (value: unknown) => {
      if (!isRealtimeInvalidationEnvelope(value)) return;
      if (value.streamId !== streamId) {
        streamId = value.streamId;
        sequence = 0;
      }
      if (value.sequence <= sequence) return;
      if (value.sequence !== sequence + 1) onTopics(value.topics);
      sequence = value.sequence;
      onTopics(value.topics);
    });
    return () => {
      socket.close();
    };
  }, [audience, onTopics]);
}
