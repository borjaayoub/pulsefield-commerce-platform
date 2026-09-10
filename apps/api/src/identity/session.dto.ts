import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { RoleName } from '../generated/prisma/enums';

export class CreateSessionDto {
  @ApiProperty({ example: 'customer@example.com', format: 'email', maxLength: 255 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ maxLength: 128, writeOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class SessionUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: RoleName, isArray: true })
  roles!: RoleName[];
}

export class SessionDto {
  @ApiProperty({ type: SessionUserDto })
  user!: SessionUserDto;

  @ApiProperty({ format: 'date-time' })
  authenticatedAt!: string;

  @ApiProperty({ format: 'date-time' })
  idleExpiresAt!: string;

  @ApiProperty({ format: 'date-time' })
  absoluteExpiresAt!: string;

  @ApiProperty({ description: 'Send this value through X-CSRF-Token.', readOnly: true })
  csrfToken!: string;
}
