import { DynamicModule, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { REALTIME_PROFILE } from './realtime.tokens';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRelayService } from './realtime-relay.service';
import { RealtimeController } from './realtime.controller';

@Module({})
export class RealtimeModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: RealtimeModule,
      controllers: [RealtimeController],
      providers: [
        { provide: REALTIME_PROFILE, useValue: profile },
        RealtimeGateway,
        RealtimeRelayService,
      ],
    };
  }
}
