import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/payment_db',
      entities: [Payment],
      synchronize: true,
      // Fast-fail DB queries when the DB is unreachable (Exp 3 partition).
      // Without these, pg waits on TCP retransmits for ~15 min and the handler
      // hangs silently — sync requests stall instead of erroring, and the
      // async consumer never reaches its nack/requeue path.
      extra: {
        query_timeout: 5000,
        statement_timeout: 5000,
        connectionTimeoutMillis: 5000,
      },
    }),
    TypeOrmModule.forFeature([Payment]),

    ClientsModule.register([
      {
        name: 'DELIVERY_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'order',
          protoPath: join(__dirname, '../../../proto/order.proto'),
          url: process.env.DELIVERY_GRPC || 'localhost:50054',
          loader: { keepCase: true },
        },
      },
      {
        name: 'PAYMENT_EVENTS',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'payment_events_queue',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],

  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
