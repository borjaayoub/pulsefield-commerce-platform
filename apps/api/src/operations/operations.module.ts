import { Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OPERATIONS_CURSOR_KEY } from './operations.constants';

@Module({ controllers: [OperationsController], providers: [OperationsService] })
export class OperationsModule {
  static forRoot(profile: LocalProfile) {
    return {
      module: OperationsModule,
      controllers: [OperationsController],
      providers: [
        OperationsService,
        { provide: OPERATIONS_CURSOR_KEY, useValue: profile.MESSAGE_ENCRYPTION_KEY_BASE64 },
      ],
    };
  }
}
