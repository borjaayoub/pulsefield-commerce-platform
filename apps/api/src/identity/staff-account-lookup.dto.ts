import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, Length } from 'class-validator';
import { AccountStatus, RoleName } from '../generated/prisma/enums';

export class StaffAccountLookupDto {
  @ApiProperty({ format: 'email', maxLength: 255, writeOnly: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class MaskedStaffAccountDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'a***@e***.com' })
  emailMasked!: string;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty()
  verified!: boolean;

  @ApiProperty({ enum: RoleName, isArray: true })
  roles!: RoleName[];
}
