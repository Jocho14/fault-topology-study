import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom, Observable } from 'rxjs';
import { Payment } from './entities/payment.entity';
import { Repository } from 'typeorm';
import { ClientGrpc, ClientProxy } from '@nestjs/microservices';
import { Topology } from './topology.enum';

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
    console.log(`[Payment] Received stock_confirmed: ${data.order_id}`);
    await this.recordPayment(data.order_id, data.price, data.quantity);

    this.rabbitClient.emit('payment_completed', data);
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
