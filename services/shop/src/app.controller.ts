import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AppService } from './app.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { Topology } from './enums/topology.enum';
import { GrpcMethod } from '@nestjs/microservices';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('orders')
  createOrder(@Body() data: CreateOrderDto) {
    return this.appService.createOrder(data);
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.appService.getOrder(id);
  }

  @Get('health')
  health() {
    return {
      service: 'shop',
      status: 'ok',
      topology: process.env.TOPOLOGY || Topology.SyncChain,
    };
  }

  @GrpcMethod('ShopService', 'CreateOrder')
  async grpcCreateOrder(data: { order_id: string } & CreateOrderDto) {
    return this.appService.storeOrder(data);
  }
}
