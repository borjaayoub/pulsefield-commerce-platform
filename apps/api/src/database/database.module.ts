import { DynamicModule, Module } from '@nestjs/common';
import { DATABASE_CONNECTION_STRING } from './database.constants';
import { PrismaService } from './prisma.service';

@Module({})
export class DatabaseModule {
  static forRoot(connectionString: string): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE_CONNECTION_STRING,
          useValue: connectionString,
        },
        PrismaService,
      ],
      exports: [PrismaService],
    };
  }
}
