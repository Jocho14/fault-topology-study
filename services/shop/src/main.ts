import 'newrelic'; // MUST stay first: loads the APM agent before any instrumented module
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { Topology } from './enums/topology.enum';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'order',
      protoPath: join(__dirname, '../../../proto/order.proto'),
      url: `0.0.0.0:${process.env.GRPC_PORT || 50051}`,
      loader: { keepCase: true },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3001);
  console.log(
    `[Shop] HTTP on port ${process.env.PORT ?? 3001}, gRPC on port ${process.env.GRPC_PORT || 50051} (topology: ${process.env.TOPOLOGY || Topology.SyncChain})`,
  );
}
bootstrap();
