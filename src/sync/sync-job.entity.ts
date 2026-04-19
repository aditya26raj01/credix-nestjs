import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SyncJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export enum SyncJobStage {
  FETCH = 'FETCH',
  EXTRACT = 'EXTRACT',
  PROCESS = 'PROCESS',
}

@Index('UQ_sync_jobs_user_running', ['userId'], {
  unique: true,
  where: `"status" = 'RUNNING'`,
})
@Entity('sync_jobs')
export class SyncJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  userId!: string;

  @Index()
  @Column({
    type: 'enum',
    enum: SyncJobStatus,
    nullable: false,
    default: SyncJobStatus.PENDING,
  })
  status!: SyncJobStatus;

  @Index()
  @Column({
    type: 'enum',
    enum: SyncJobStage,
    nullable: false,
    default: SyncJobStage.FETCH,
  })
  stage!: SyncJobStage;

  @Column({ type: 'timestamptz', nullable: false })
  fromDate!: Date;

  @Column({ type: 'timestamptz', nullable: false })
  toDate!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastProcessedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
