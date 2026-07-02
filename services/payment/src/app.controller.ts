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

  // Work preservation across transient DB outages (Exp 3's payment<->postgres
  // partition): the service method retries the DB write with backoff until it
  // succeeds. While retrying, the message stays in-flight (unacked) on this
  // consumer — RabbitMQ doesn't redeliver it. Other messages queue up safely
  // behind it. Once the DB recovers, the retry succeeds, this handler returns
  // normally, and NestJS auto-acks. We don't fight NestJS's ack/nack flow.
  @EventPattern('stock_confirmed')
  async handleStockConfirmed(@Payload() data: OrderDataDto) {
    await this.appService.handleStockConfirmed(data);
  }
}
