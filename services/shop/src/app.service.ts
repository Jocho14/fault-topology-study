import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { Repository } from 'typeorm';
import { ClientGrpc, ClientProxy } from '@nestjs/microservices';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom, Observable } from 'rxjs';
import { Topology } from './enums/topology.enum';
import { OrderStatus } from './enums/order-status.enum';

interface OrderData {
  order_id: string;
  car_model: string;
  quantity: number;
  price: number;
  customer_id: string;
}

interface OrderResponse {
  order_id: string;
  status: string;
  message: string;
}

interface WarehouseService {
  CheckStock(data: OrderData): Observable<OrderResponse>;
}

@Injectable()
export class AppService implements OnModuleInit {
  private warehouseService: WarehouseService;

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject('WAREHOUSE_PACKAGE') private warehouseClient: ClientGrpc,
    @Inject('ORDER_EVENTS') private readonly rabbitClient: ClientProxy,
  ) {}

  onModuleInit() {
    this.warehouseService =
      this.warehouseClient.getService<WarehouseService>('WarehouseService');
  }

  async createOrder(dto: {
    car_model: string;
    quantity: number;
    price: number;
    customer_id: string;
  }): Promise<void> {
    const orderId = uuidv4();
    const orderData = { order_id: orderId, ...dto };

    const order = this.orderRepository.create({
      id: orderId,
      ...dto,
      status: OrderStatus.Pending,
    });

    await this.orderRepository.save(order);
    await this.processOrder(
      orderData,
      (process.env.TOPOLOGY as Topology) || Topology.SyncChain,
    );
  }

  private async processOrder(
    orderData: OrderData,
    topology: Topology,
  ): Promise<OrderResponse> {
    switch (topology) {
      case Topology.SyncChain: {
        const result = await firstValueFrom(
          this.warehouseService.CheckStock(orderData),
        );
        await this.orderRepository.update(orderData.order_id, {
          status: result.status,
        });
        return {
          order_id: orderData.order_id,
          status: result.status,
          message: result.message,
        };
      }
      case Topology.SynchOrchestrator: {
        await this.orderRepository.update(orderData.order_id, {
          status: OrderStatus.Accepted,
        });
        return {
          order_id: orderData.order_id,
          status: OrderStatus.Accepted,
          message: 'Order saved, orchestrator will process',
        };
      }
      case Topology.AsyncEvent: {
        this.rabbitClient.emit('order_created', orderData);
        await this.orderRepository.update(orderData.order_id, {
          status: OrderStatus.Accepted,
        });
        return {
          order_id: orderData.order_id,
          status: OrderStatus.Accepted,
          message: 'Order accepted, processing async',
        };
      }
      default:
        throw new Error(`Unknown topology`);
    }
  }

  async storeOrder(data: OrderData): Promise<OrderResponse> {
    await this.orderRepository.save({
      id: data.order_id,
      car_model: data.car_model,
      quantity: data.quantity,
      price: data.price,
      customer_id: data.customer_id,
      status: OrderStatus.Confirmed,
    });

    return {
      order_id: data.order_id,
      status: OrderStatus.Confirmed,
      message: 'Order stored by shop',
    };
  }

  async getOrder(id: string): Promise<Order | null> {
    return this.orderRepository.findOneBy({ id });
  }
}
