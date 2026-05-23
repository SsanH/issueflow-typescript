import { Comment } from './comment.entity';

// Per README, every comment GET response includes mentionedUsers.
// Phase 4 returns []; Phase 6d populates it from CommentMention rows (G3).
// Centralizing here so Phase 6d only has to swap the [] for real data.
export interface MentionedUser {
  id: number;
  username: string;
  fullName: string;
}

export interface CommentResponse {
  id: number;
  ticketId: number;
  authorId: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  mentionedUsers: MentionedUser[];
}

export function toCommentResponse(c: Comment): CommentResponse {
  return {
    id: c.id,
    ticketId: c.ticketId,
    authorId: c.authorId,
    content: c.content,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    mentionedUsers: [],
  };
}
