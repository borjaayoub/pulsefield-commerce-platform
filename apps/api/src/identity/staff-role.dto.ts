import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, Length } from 'class-validator';
import { RoleName } from '../generated/prisma/enums';

export const MANAGEABLE_STAFF_ROLES = [RoleName.FULFILLER, RoleName.ADMINISTRATOR] as const;

export class StaffRoleParametersDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: MANAGEABLE_STAFF_ROLES })
  @IsIn(MANAGEABLE_STAFF_ROLES)
  role!: (typeof MANAGEABLE_STAFF_ROLES)[number];
}

export class ChangeStaffRoleDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class StaffRoleAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ enum: RoleName, isArray: true })
  roles!: RoleName[];
}
