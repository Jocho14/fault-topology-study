import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockCheck } from './entities/stock-check.entity';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: 'postgresql://postgres:postgres@localhost:5432/warehouse_db',
      entities: [StockCheck],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([StockCheck]),
    ClientsModule.register([
      {
        name: 'PAYMENT_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'order',
          protoPath: join(__dirname, '../../../proto/order.proto'),
          url: process.env.PAYMENT_GRPC || 'localhost:50053',
        },
      },
      {
        name: 'STOCK_EVENTS',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'stock_queue_events',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
