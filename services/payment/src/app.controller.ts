import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Topology } from './topology.enum';
import { EventPattern, GrpcMethod, Payload } from '@nestjs/microservices';
import { OrderDataDto } from './dto/order-data.dto';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health() {
    return {
      service: 'payment',
      status: 'ok',
      topology: process.env.TOPOLOGY || Topology.SyncChain,
    };
  }

  @GrpcMethod('PaymentService', 'ProcessPayment')
  async processPayment(data: OrderDataDto) {
    return this.appService.processPayment(data);
  }

  @EventPattern('stock_confirmed')
  async handleStockConfirmed(@Payload() data: OrderDataDto) {
    await this.appService.handleStockConfirmed(data);
  }
}
