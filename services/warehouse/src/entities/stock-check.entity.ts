import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('stock_checks')
export class StockCheck {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  order_id: string;

  @Column()
  status: string;

  @CreateDateColumn()
  checked_at: Date;
}
