import { Body, Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('orders')
  async createOrder(@Body() data: CreateOrderDto) {
    return this.appService.createOrder(data);
  }

  @Get('health')
  health() {
    return { service: 'orchestrator', status: 'ok' };
  }
}
