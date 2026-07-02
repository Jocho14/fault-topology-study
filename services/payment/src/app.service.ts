import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom, Observable } from 'rxjs';
import { Payment } from './entities/payment.entity';
import { Repository } from 'typeorm';
import { ClientGrpc, ClientProxy } from '@nestjs/microservices';
import { Topology } from './topology.enum';
import { injectTrace, acceptTrace } from './nr-trace';

interface OrderData {
  order_id: string;
  car_model: string;
  quantity: number;
  price: number;
  customer_id: string;
}

export interface OrderResponse {
  order_id: string;
  status: string;
  message: string;
}

interface DeliveryGrpcService {
  ScheduleDelivery(data: OrderData): Observable<OrderResponse>;
}

@Injectable()
export class AppService implements OnModuleInit {
  private deliveryService: DeliveryGrpcService;

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @Inject('DELIVERY_PACKAGE') private readonly deliveryClient: ClientGrpc,
    @Inject('PAYMENT_EVENTS') private readonly rabbitClient: ClientProxy,
  ) {}

  onModuleInit() {
    this.deliveryService =
      this.deliveryClient.getService<DeliveryGrpcService>('DeliveryService');
  }

  async processPayment(data: OrderData) {
    await this.recordPayment(data.order_id, data.price, data.quantity);

    const topology = (process.env.TOPOLOGY as Topology) || Topology.SyncChain;

    switch (topology) {
      case Topology.SyncChain:
        return firstValueFrom(this.deliveryService.ScheduleDelivery(data));

      case Topology.SynchOrchestrator:
        return {
          order_id: data.order_id,
          status: 'payment_completed',
          message: `Payment of ${data.price * data.quantity} processed`,
        };

      default:
        throw new Error('Unknown topology');
    }
  }

  async handleStockConfirmed(data: OrderData) {
    acceptTrace(data);
    console.log(`[Payment] Received stock_confirmed: ${data.order_id}`);
    // Retry the DB write with backoff so transient outages (Exp 3 partition)
    // don't drop work. The message stays in-flight (unacked) on the consumer
    // while we retry — RabbitMQ keeps it safe and won't redeliver it.
    await this.recordPaymentWithRetry(data);
    this.rabbitClient.emit('payment_completed', injectTrace(data));
  }

  private async recordPaymentWithRetry(data: OrderData): Promise<void> {
    const maxAttempts = 90; // ~3 min, well above the 60s partition
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.recordPayment(data.order_id, data.price, data.quantity);
        if (attempt > 1) {
          console.log(
            `[Payment] DB recovered on attempt ${attempt} for ${data.order_id}`,
          );
        }
        return;
      } catch (err: any) {
        lastErr = err;
        if (attempt === 1 || attempt % 10 === 0) {
          console.warn(
            `[Payment] DB attempt ${attempt}/${maxAttempts} failed for ${data.order_id}: ${err?.message ?? err}`,
          );
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastErr;
  }

  private async recordPayment(
    orderId: string,
    price: number,
    quantity: number,
  ): Promise<void> {
    const amount = price * quantity;
    await this.paymentRepository.save({
      order_id: orderId,
      amount,
      status: 'completed',
    });
  }
}
