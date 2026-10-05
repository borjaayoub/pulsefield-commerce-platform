import { Module } from '@nestjs/common';
import { ShoppingConfigurationService } from './shopping-configuration.service';

@Module({ providers: [ShoppingConfigurationService], exports: [ShoppingConfigurationService] })
export class ShoppingConfigurationModule {}
