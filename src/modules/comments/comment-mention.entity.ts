import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Comment } from './comment.entity';

// One row per (comment, mentioned user) pair. CASCADE on commentId so
// deleting a comment cleans up its mentions automatically.
@Entity('comment_mentions')
@Index(['commentId', 'userId'], { unique: true })
export class CommentMention {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'comment_id', type: 'int' })
  commentId: number;

  @ManyToOne(() => Comment, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'comment_id' })
  comment: Comment;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
