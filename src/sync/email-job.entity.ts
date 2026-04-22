import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum EmailJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

@Index('IDX_email_jobs_sync_job_id', ['syncJobId'])
@Index('IDX_email_jobs_user_id', ['userId'])
@Index('UQ_email_jobs_sync_email', ['syncJobId', 'emailId'], {
  unique: true,
})
@Entity('email_jobs')
export class EmailJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  syncJobId!: string;

  @Column({ type: 'uuid', nullable: false })
  userId!: string;

  @Column({ type: 'text', nullable: false })
  emailId!: string;

  @Index()
  @Column({
    type: 'enum',
    enum: EmailJobStatus,
    nullable: false,
    default: EmailJobStatus.PENDING,
  })
  status!: EmailJobStatus;

  @Column({ type: 'text', nullable: true })
  s3RawKey!: string | null;

  @Column({ type: 'text', nullable: true })
  s3AttachmentKey!: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
