import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class RegisterCustomerDto {
  @ApiProperty({ example: 'customer@example.com', format: 'email', maxLength: 255 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ minLength: 15, maxLength: 128, writeOnly: true })
  @IsString()
  password!: string;
}

export class VerifyEmailDto {
  @ApiProperty({
    description: 'Single-use bearer credential received through the local email workflow.',
    writeOnly: true,
  })
  @IsString({ message: 'INVALID_EMAIL_VERIFICATION_TOKEN' })
  token!: string;
}

export class RequestEmailVerificationDto {
  @ApiProperty({ example: 'customer@example.com', format: 'email', maxLength: 255 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class RegistrationAcceptedDto {
  @ApiProperty({ enum: ['VERIFICATION_REQUIRED'] })
  status!: 'VERIFICATION_REQUIRED';
}

export class VerificationRequestAcceptedDto {
  @ApiProperty({ enum: ['REQUEST_ACCEPTED'] })
  status!: 'REQUEST_ACCEPTED';
}

export class RequestPasswordRecoveryDto {
  @ApiProperty({ example: 'customer@example.com', format: 'email', maxLength: 255 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Single-use bearer credential received through the local recovery workflow.',
    writeOnly: true,
  })
  @IsString({ message: 'INVALID_PASSWORD_RESET_TOKEN' })
  token!: string;

  @ApiProperty({ minLength: 15, maxLength: 128, writeOnly: true })
  @IsString()
  newPassword!: string;
}

export class PasswordRecoveryRequestAcceptedDto {
  @ApiProperty({ enum: ['REQUEST_ACCEPTED'] })
  status!: 'REQUEST_ACCEPTED';
}
