import { ShoppingConfigurationModule } from '../checkout/shopping-configuration.module';
import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { CartRetentionScheduler } from './cart-retention.scheduler';

@Module({
  imports: [ShoppingConfigurationModule],
  controllers: [CartController],
  providers: [CartService, CartRetentionScheduler],
  exports: [CartService],
})
export class CartModule {}
