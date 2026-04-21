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
      service: 'warehouse',
      status: 'ok',
      topology: process.env.TOPOLOGY || Topology.SyncChain,
    };
  }

  @GrpcMethod('WarehouseService', 'CheckStock')
  async checkStock(data: OrderDataDto) {
    return this.appService.checkStock(data);
  }

  @EventPattern('order_created')
  async handleOrderCreated(@Payload() data: OrderDataDto) {
    await this.appService.handleOrderCreated(data);
  }
}
