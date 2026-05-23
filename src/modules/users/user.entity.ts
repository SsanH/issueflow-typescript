import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TIMESTAMPTZ_COLUMN_OPTS } from '../../database/column-opts';

export type UserRole = 'ADMIN' | 'DEVELOPER';
export const USER_ROLES: UserRole[] = ['ADMIN', 'DEVELOPER'];

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  username: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 256 })
  email: string;

  @Column({ name: 'full_name', type: 'varchar', length: 256 })
  fullName: string;

  @Column({ type: 'varchar', length: 16 })
  role: UserRole;

  // D5: bcrypt hash. `select: false` keeps it off default SELECTs; @Exclude()
  // makes class-transformer drop it from serialized responses. Belt + suspenders.
  @Exclude()
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 128,
    select: false,
  })
  passwordHash: string;

  @CreateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'created_at' })
  createdAt: Date;
}
