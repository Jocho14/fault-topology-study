import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { Topology } from './topology.enum';

const TOPOLOGY = (process.env.TOPOLOGY as Topology) || Topology.SyncChain;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'order',
      protoPath: join(__dirname, '../../../proto/order.proto'),
      url: `0.0.0.0:${process.env.GRPC_PORT || 50054}`,
      loader: { keepCase: true },
    },
  });

  if (TOPOLOGY === Topology.AsyncEvent) {
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
        queue: 'payment_events_queue',
        queueOptions: { durable: true },
      },
    });
  }

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3004);
  console.log(
    `[Delivery] HTTP on port ${process.env.PORT ?? 3004}, gRPC on port ${process.env.GRPC_PORT || 50054} (topology: ${TOPOLOGY})`,
  );
}
bootstrap();
