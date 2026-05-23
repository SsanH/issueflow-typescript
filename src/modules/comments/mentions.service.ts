import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Comment } from './comment.entity';
import { CommentMention } from './comment-mention.entity';
import { CommentResponse, MentionedUser } from './comment-response';

// D32: response shape matches the README example verbatim: { data, total, page }.
// `pageSize` is still accepted as a query param (per README "Optional: page,
// pageSize") and used internally for pagination — it's just not echoed in the
// response body.
export interface MentionsPage {
  data: CommentResponse[];
  total: number;
  page: number;
}

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class MentionsService {
  constructor(
    @InjectRepository(CommentMention)
    private readonly mentions: Repository<CommentMention>,
    @InjectRepository(Comment)
    private readonly comments: Repository<Comment>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async listForUser(
    userId: number,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<MentionsPage> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const p = Math.max(1, page);
    const ps = Math.min(200, Math.max(1, pageSize));

    // Two-step query to avoid TypeORM's skip+take-with-JOIN ambiguity in 0.3.x.
    // Step 1: raw query for comment ids that mention this user, ordered by
    // comment.created_at DESC, paginated.
    const idRows: { comment_id: number }[] = await this.mentions.query(
      `SELECT m.comment_id
         FROM comment_mentions m
         JOIN comments c ON c.id = m.comment_id
        WHERE m.user_id = $1
        ORDER BY c.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, ps, (p - 1) * ps],
    );
    const totalRow: { count: string }[] = await this.mentions.query(
      `SELECT COUNT(*)::text AS count
         FROM comment_mentions
        WHERE user_id = $1`,
      [userId],
    );
    const total = Number(totalRow[0].count);

    if (idRows.length === 0) {
      return { data: [], total, page: p };
    }

    const commentIds = idRows.map((r) => r.comment_id);
    const comments = await this.comments.find({
      where: { id: In(commentIds) },
    });
    // Preserve query order: build a Map from comment id → comment.
    const byId = new Map(comments.map((c) => [c.id, c]));

    // For each result comment, also load its full mentionedUsers list so
    // the response matches the README contract shape.
    const allMentions = await this.mentions.find({
      where: { commentId: In(commentIds) },
    });
    const userIds = Array.from(new Set(allMentions.map((m) => m.userId)));
    const users = userIds.length
      ? await this.users.find({ where: { id: In(userIds) } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const mentionsByComment = new Map<number, MentionedUser[]>();
    for (const m of allMentions) {
      const u = userById.get(m.userId);
      if (!u) continue;
      const list = mentionsByComment.get(m.commentId) ?? [];
      list.push({ id: u.id, username: u.username, fullName: u.fullName });
      mentionsByComment.set(m.commentId, list);
    }

    const data: CommentResponse[] = idRows
      .map((r) => byId.get(r.comment_id))
      .filter((c): c is Comment => c !== undefined)
      .map((c) => ({
        id: c.id,
        ticketId: c.ticketId,
        authorId: c.authorId,
        content: c.content,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        mentionedUsers: mentionsByComment.get(c.id) ?? [],
      }));

    return { data, total, page: p };
  }
}
