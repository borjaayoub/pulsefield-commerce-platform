import { RealtimeGateway } from './realtime.gateway';

type TestSocket = {
  connected: boolean;
  handshake: { headers: { origin: string }; auth: { audience: 'public' | 'staff' } };
  data: Record<string, unknown>;
  emit: jest.Mock;
  disconnect: jest.Mock;
};

function client(audience: 'public' | 'staff'): TestSocket {
  return {
    connected: true,
    handshake: { headers: { origin: 'http://localhost:3000' }, auth: { audience } },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('RealtimeGateway', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('accepts an anonymous Socket.IO client but emits only catalog invalidations', async () => {
    const gateway = new RealtimeGateway(
      { WEB_ORIGIN: 'http://localhost:3000' } as never,
      { currentCapability: jest.fn() } as never,
    );
    const socket = client('public');
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('resync', { version: 1 });
    gateway.publish(['catalog', 'inventory']);
    await jest.advanceTimersByTimeAsync(250);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'invalidate',
      expect.objectContaining({ version: 1, sequence: 1, topics: ['catalog'] }),
    );
  });

  it('rejects missing or cross-origin Socket.IO handshakes', async () => {
    const gateway = new RealtimeGateway(
      { WEB_ORIGIN: 'http://localhost:3000' } as never,
      { currentCapability: jest.fn() } as never,
    );
    const socket = client('public');
    socket.handshake.headers.origin = 'http://attacker.example';
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
