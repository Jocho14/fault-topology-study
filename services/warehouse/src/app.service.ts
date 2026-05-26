import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom, Observable } from 'rxjs';
import { StockCheck } from './entities/stock-check.entity';
import { Repository } from 'typeorm';
import { Topology } from './topology.enum';
import { ClientGrpc, ClientProxy } from '@nestjs/microservices';
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

interface PaymentGrpcService {
  ProcessPayment(data: OrderData): Observable<OrderResponse>;
}

@Injectable()
export class AppService implements OnModuleInit {
  private paymentsService: PaymentGrpcService;

  constructor(
    @InjectRepository(StockCheck)
    private readonly stockCheckRepository: Repository<StockCheck>,
    @Inject('PAYMENT_PACKAGE') private readonly paymentClient: ClientGrpc,
    @Inject('STOCK_EVENTS') private readonly rabbitClient: ClientProxy,
  ) {}

  onModuleInit() {
    this.paymentsService =
      this.paymentClient.getService<PaymentGrpcService>('PaymentService');
  }

  async checkStock(data: OrderData) {
    await this.recordStockCheck(data.order_id);

    const topology = (process.env.TOPOLOGY as Topology) || Topology.SyncChain;

    switch (topology) {
      case Topology.SyncChain:
        return firstValueFrom(this.paymentsService.ProcessPayment(data));

      case Topology.SynchOrchestrator:
        return {
          order_id: data.order_id,
          status: 'stock_confirmed',
          message: 'Stock available',
        };

      default:
        throw new Error('Unknown topology');
    }
  }

  async handleOrderCreated(data: OrderData) {
    acceptTrace(data);
    console.log(`[Warehouse] Received order_created: ${data.order_id}`);
    await this.recordStockCheck(data.order_id);

    this.rabbitClient.emit('stock_confirmed', injectTrace(data));
  }

  private async recordStockCheck(orderId: string): Promise<void> {
    await this.stockCheckRepository.save({
      order_id: orderId,
      status: 'in_stock',
    });
  }
}
