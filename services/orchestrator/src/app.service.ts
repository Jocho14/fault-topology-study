import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

export interface OrderData {
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

interface ShopGrpcService {
  CreateOrder(data: OrderData): Observable<OrderResponse>;
}
interface WarehouseGrpcService {
  CheckStock(data: OrderData): Observable<OrderResponse>;
}
interface PaymentGrpcService {
  ProcessPayment(data: OrderData): Observable<OrderResponse>;
}
interface DeliveryGrpcService {
  ScheduleDelivery(data: OrderData): Observable<OrderResponse>;
}

@Injectable()
export class AppService implements OnModuleInit {
  private shopService: ShopGrpcService;
  private warehouseService: WarehouseGrpcService;
  private paymentService: PaymentGrpcService;
  private deliveryService: DeliveryGrpcService;

  constructor(
    @Inject('SHOP_PACKAGE') private readonly shopClient: ClientGrpc,
    @Inject('WAREHOUSE_PACKAGE') private readonly warehouseClient: ClientGrpc,
    @Inject('PAYMENT_PACKAGE') private readonly paymentClient: ClientGrpc,
    @Inject('DELIVERY_PACKAGE') private readonly deliveryClient: ClientGrpc,
  ) {}
  onModuleInit() {
    this.shopService =
      this.shopClient.getService<ShopGrpcService>('ShopService');
    this.warehouseService =
      this.warehouseClient.getService<WarehouseGrpcService>('WarehouseService');
    this.paymentService =
      this.paymentClient.getService<PaymentGrpcService>('PaymentService');
    this.deliveryService =
      this.deliveryClient.getService<DeliveryGrpcService>('DeliveryService');
  }

  async createOrder(dto: {
    car_model: string;
    quantity: number;
    price: number;
    customer_id: string;
  }): Promise<OrderResponse> {
    const orderId = uuidv4();
    const orderData: OrderData = { order_id: orderId, ...dto };

    const shopResult = await firstValueFrom(
      this.shopService.CreateOrder(orderData),
    );
    if (shopResult.status !== 'confirmed')
      return {
        order_id: orderId,
        status: 'failed',
        message: `Shop: ${shopResult.message}`,
      };

    const warehouseResult = await firstValueFrom(
      this.warehouseService.CheckStock(orderData),
    );
    if (warehouseResult.status !== 'stock_confirmed') {
      return {
        order_id: orderId,
        status: 'failed',
        message: `Warehouse: ${warehouseResult.message}`,
      };
    }

    const paymentResult = await firstValueFrom(
      this.paymentService.ProcessPayment(orderData),
    );
    if (paymentResult.status !== 'payment_completed') {
      return {
        order_id: orderId,
        status: 'failed',
        message: `Payment: ${paymentResult.message}`,
      };
    }

    const deliveryResult = await firstValueFrom(
      this.deliveryService.ScheduleDelivery(orderData),
    );
    return {
      order_id: orderId,
      status: deliveryResult.status,
      message: deliveryResult.message,
    };
  }
}
