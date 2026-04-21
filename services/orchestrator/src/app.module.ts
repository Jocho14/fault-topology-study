import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';

const PROTO_PATH = join(__dirname, '../../../proto/order.proto');

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'SHOP_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'order',
          protoPath: PROTO_PATH,
          url: process.env.SHOP_GRPC || 'localhost:50051',
          loader: { keepCase: true },
        },
      },
      {
        name: 'WAREHOUSE_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'order',
          protoPath: PROTO_PATH,
          url: process.env.WAREHOUSE_GRPC || 'localhost:50052',
          loader: { keepCase: true },
        },
      },
      {
        name: 'PAYMENT_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'order',
          protoPath: PROTO_PATH,
          url: process.env.PAYMENT_GRPC || 'localhost:50053',
          loader: { keepCase: true },
        },
      },
      {
        name: 'DELIVERY_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'order',
          protoPath: PROTO_PATH,
          url: process.env.DELIVERY_GRPC || 'localhost:50054',
          loader: { keepCase: true },
        },
      },
    ]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
