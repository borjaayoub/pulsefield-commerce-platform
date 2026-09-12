import { DynamicModule, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { AuditModule } from '../audit/audit.module';
import {
  ReservationExpiryScheduler,
  RESERVATION_EXPIRY_PROFILE,
} from './reservation-expiry.scheduler';
import { ReservationExpiryService } from './reservation-expiry.service';

@Module({ imports: [AuditModule] })
export class ReservationExpiryModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: ReservationExpiryModule,
      imports: [AuditModule],
      providers: [
        { provide: RESERVATION_EXPIRY_PROFILE, useValue: profile },
        ReservationExpiryService,
        ReservationExpiryScheduler,
      ],
      exports: [ReservationExpiryService],
    };
  }
}
