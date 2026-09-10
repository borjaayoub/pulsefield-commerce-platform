import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProblemDetailsDto {
  @ApiProperty({ example: 'urn:pulse-field:problem:request-validation-failed' })
  type!: string;

  @ApiProperty({ example: 'Bad Request' })
  title!: string;

  @ApiProperty({ example: 400 })
  status!: number;

  @ApiProperty({ example: 'Request validation failed.' })
  detail!: string;

  @ApiProperty({ example: '/api/v1/auth/registrations' })
  instance!: string;

  @ApiProperty({ example: 'REQUEST_VALIDATION_FAILED' })
  code!: string;

  @ApiProperty({ example: '2ea2159f-6ae9-4d6b-a5ec-833e6864532e' })
  requestId!: string;

  @ApiPropertyOptional({ type: [String] })
  errors?: string[];
}
