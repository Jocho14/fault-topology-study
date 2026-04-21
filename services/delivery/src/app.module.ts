import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/delivery_db',
      entities: [Delivery],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Delivery]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
