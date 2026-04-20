import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host:
        process.env.DB_HOST ||
        'postgresql://postgres:postgres@localhost:5432/shop_db',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'shop_db',
      entities: [Order],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Order]),
    ClientsModule.register([
      {
        name: 'WAREHOUSE_PACKAGE',
        transport: Transport.GRPC,
        options: {
          url: process.env.WAREHOUSE_URL || 'localhost:5001',
          package: 'order',
          protoPath: join(__dirname, '../../../proto/order.proto'),
          loader: { keepCase: true },
        },
      },
      {
        name: 'ORDER_EVENTS',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'orders',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
