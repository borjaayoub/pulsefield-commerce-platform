import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class MfaChallengeTokenDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  challengeToken!: string;
}

export class CompleteMfaEnrollmentDto extends MfaChallengeTokenDto {
  @ApiProperty({ pattern: '^\\d{6}$', writeOnly: true })
  @IsString()
  @Matches(/^\d{6}$/)
  totpCode!: string;
}

export class CompleteMfaAuthenticationDto extends MfaChallengeTokenDto {
  @ApiPropertyOptional({ pattern: '^\\d{6}$', writeOnly: true })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpCode?: string;

  @ApiPropertyOptional({ pattern: '^[A-F0-9]{5}(-[A-F0-9]{5}){3}$', writeOnly: true })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Fa-f0-9]{5}(-[A-Fa-f0-9]{5}){3}$/)
  recoveryCode?: string;
}

export class CompleteStaffReauthenticationDto {
  @ApiProperty({ minLength: 1, maxLength: 128, writeOnly: true })
  @IsString()
  password!: string;

  @ApiPropertyOptional({ pattern: '^\\d{6}$', writeOnly: true })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpCode?: string;

  @ApiPropertyOptional({ pattern: '^[A-F0-9]{5}(-[A-F0-9]{5}){3}$', writeOnly: true })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Fa-f0-9]{5}(-[A-Fa-f0-9]{5}){3}$/)
  recoveryCode?: string;
}

export class MfaRequiredDto {
  @ApiProperty({ enum: ['MFA_REQUIRED'] })
  status!: 'MFA_REQUIRED';
  @ApiProperty({ readOnly: true })
  challengeToken!: string;
  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

export class MfaEnrollmentRequiredDto {
  @ApiProperty({ enum: ['MFA_ENROLLMENT_REQUIRED'] })
  status!: 'MFA_ENROLLMENT_REQUIRED';
  @ApiProperty({ readOnly: true })
  challengeToken!: string;
  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
  @ApiProperty({ readOnly: true })
  sharedSecret!: string;
  @ApiProperty({ readOnly: true })
  provisioningUri!: string;
}

export class MfaEnrolledDto {
  @ApiProperty({ enum: ['MFA_ENROLLED'] })
  status!: 'MFA_ENROLLED';
  @ApiProperty({ type: [String], readOnly: true })
  recoveryCodes!: string[];
}
