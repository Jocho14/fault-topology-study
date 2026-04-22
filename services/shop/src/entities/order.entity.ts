import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryColumn()
  id: string;

  @Column()
  car_model: string;

  @Column()
  quantity: number;

  @Column('decimal')
  price: number;

  @Column()
  customer_id: string;

  @Column()
  status: string;
}
