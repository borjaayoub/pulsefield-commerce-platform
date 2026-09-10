import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length } from 'class-validator';

export class NotificationDeliveryReplayParametersDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deliveryId!: string;
}

export class ReplayNotificationDeliveryDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class NotificationDeliveryReplayAcceptedDto {
  @ApiProperty({ format: 'uuid' })
  deliveryId!: string;

  @ApiProperty({ format: 'uuid' })
  replayEventId!: string;
}
