import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';
import { Repository } from 'typeorm';

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

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
  ) {}

  async scheduleDelivery(data: OrderData) {
    await this.recordDelivery(data.order_id);
    return {
      order_id: data.order_id,
      status: 'completed',
      message:
        'Order fully processed: stock checked, payment done, delivery scheduled',
    };
  }

  async handlePaymentCompletedEvent(data: OrderData) {
    console.log(`[Delivery] Received payment_completed: ${data.order_id}`);
    await this.recordDelivery(data.order_id);

    console.log(`[Delivery] Order ${data.order_id} fully processed`);
  }

  private async recordDelivery(orderId: string) {
    await this.deliveryRepository.save({
      order_id: orderId,
      status: 'scheduled',
    });
  }
}
