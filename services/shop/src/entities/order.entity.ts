import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryColumn()
  id: string;

  @Column()
  carModel: string;

  @Column()
  quantity: number;

  @Column('decimal')
  price: number;

  @Column()
  customerId: string;

  @Column()
  status: string;
}
