import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('deliveries')
export class Delivery {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  order_id: string;

  @Column()
  status: string;

  @CreateDateColumn()
  scheduled_at: Date;
}
