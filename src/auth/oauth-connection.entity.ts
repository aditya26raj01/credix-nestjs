import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../user/user.entity';

export enum OAuthProvider {
  GOOGLE = 'google',
}

@Entity('oauth_connections')
@Unique(['provider', 'providerAccountId'])
@Unique(['userId', 'provider'])
export class OAuthConnectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @Column({ type: 'enum', enum: OAuthProvider, nullable: false })
  provider!: OAuthProvider;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: false })
  providerAccountId!: string;

  @Column({ type: 'varchar', length: 320, nullable: false })
  providerEmail!: string;

  @Column({ type: 'text', nullable: true })
  accessTokenEncrypted!: string | null;

  @Column({ type: 'text', nullable: true })
  refreshTokenEncrypted!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  accessTokenExpiresAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  scope!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  tokenType!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
