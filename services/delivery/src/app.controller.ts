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
      service: 'delivery',
      status: 'ok',
      topology: process.env.TOPOLOGY || Topology.SyncChain,
    };
  }

  @GrpcMethod('DeliveryService', 'ScheduleDelivery')
  async scheduleDelivery(data: OrderDataDto) {
    return this.appService.scheduleDelivery(data);
  }

  @EventPattern('payment_completed')
  async handlePaymentCompleted(@Payload() data: OrderDataDto) {
    await this.appService.handlePaymentCompletedEvent(data);
  }
}
