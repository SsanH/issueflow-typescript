import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { TicketsService } from '../tickets/tickets.service';
import { Comment } from './comment.entity';
import { CommentMention } from './comment-mention.entity';
import {
  CommentResponse,
  MentionedUser,
  toCommentResponse,
} from './comment-response';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { extractMentions } from './mentions';

// D26: shape of the authenticated requester passed down from the controller.
export interface CommentRequester {
  id: number;
  role: UserRole;
}

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment) private readonly comments: Repository<Comment>,
    @InjectRepository(CommentMention)
    private readonly mentions: Repository<CommentMention>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tickets: TicketsService,
  ) {}

  async listByTicket(ticketId: number): Promise<CommentResponse[]> {
    await this.tickets.findById(ticketId);
    const rows = await this.comments.find({
      where: { ticketId },
      order: { createdAt: 'ASC' },
    });
    // Read-only path — no transaction needed, class-level repos are fine.
    return this.projectMentions(rows);
  }

  // D25: comment + mention writes share a single transaction.
  // Same-handler reads after writes go through the manager so the response
  // body sees post-write state, not the pre-transaction snapshot.
  async create(
    ticketId: number,
    dto: CreateCommentDto,
    requester: CommentRequester,
  ): Promise<CommentResponse> {
    await this.tickets.findById(ticketId);
    if (dto.authorId !== undefined && dto.authorId !== requester.id) {
      throw new BadRequestException(
        'authorId in body must match the authenticated user',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Comment);
      const entity = repo.create({
        ticketId,
        authorId: requester.id,
        content: dto.content,
      });
      const saved = await repo.save(entity);
      await this.upsertMentions(saved.id, dto.content, manager);
      return (await this.projectMentions([saved], manager))[0];
    });
  }

  async update(
    ticketId: number,
    commentId: number,
    dto: UpdateCommentDto,
    requester: CommentRequester,
  ): Promise<CommentResponse> {
    // D31: parent-ticket-visibility gate (also catches soft-deleted
    // project upstream). Cheap pre-check before the locked update.
    await this.tickets.findById(ticketId);
    return this.dataSource.transaction(async (manager) => {
      const comment = await manager.findOne(Comment, {
        where: { id: commentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!comment) {
        throw new NotFoundException(`Comment ${commentId} not found`);
      }
      if (comment.ticketId !== ticketId) {
        throw new NotFoundException(
          `Comment ${commentId} does not belong to ticket ${ticketId}`,
        );
      }

      // D26: author/ADMIN-only edit.
      this.assertCanModify(comment, requester);

      comment.content = dto.content;
      const saved = await manager.save(comment);
      // D25: mention diff inside the same transaction; reads of the result
      // go through `manager` so the response body reflects the post-write
      // state (not the pre-transaction snapshot visible to class-level
      // repos via a different pool connection).
      await this.upsertMentions(saved.id, dto.content, manager);
      return (await this.projectMentions([saved], manager))[0];
    });
  }

  async remove(
    ticketId: number,
    commentId: number,
    requester: CommentRequester,
  ): Promise<void> {
    // D31: parent-ticket-visibility gate.
    await this.tickets.findById(ticketId);
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment) {
      throw new NotFoundException(`Comment ${commentId} not found`);
    }
    if (comment.ticketId !== ticketId) {
      throw new NotFoundException(
        `Comment ${commentId} does not belong to ticket ${ticketId}`,
      );
    }
    // D26: author/ADMIN-only delete.
    this.assertCanModify(comment, requester);
    // Mentions cascade-delete via FK.
    await this.comments.remove(comment);
  }

  // D26: gate edit + delete on authorship OR ADMIN role.
  // Carve-out from D18 (open-CRUD default) because authorship is the
  // comment's whole identity.
  private assertCanModify(comment: Comment, requester: CommentRequester): void {
    const isAuthor = comment.authorId === requester.id;
    const isAdmin = requester.role === 'ADMIN';
    if (!isAuthor && !isAdmin) {
      throw new ForbiddenException(
        'Only the comment author or an ADMIN may modify this comment',
      );
    }
  }

  // --- mention helpers ---

  // Resolve usernames → user rows (case-insensitive LOWER comparison).
  // Reads users via `manager` when inside a transaction so we see uncommitted
  // user creates from the same handler. (No current path does that, but the
  // discipline matches projectMentions.)
  private async resolveUsers(
    usernames: string[],
    manager?: EntityManager,
  ): Promise<User[]> {
    if (usernames.length === 0) return [];
    const repo = manager ? manager.getRepository(User) : this.users;
    return repo
      .createQueryBuilder('u')
      .where('LOWER(u.username) IN (:...names)', {
        names: usernames.map((n) => n.toLowerCase()),
      })
      .getMany();
  }

  // Compute target mentions for a comment's text; diff against existing
  // CommentMention rows; insert added, delete removed.
  private async upsertMentions(
    commentId: number,
    content: string,
    manager?: EntityManager,
  ): Promise<void> {
    const mentionRepo = manager
      ? manager.getRepository(CommentMention)
      : this.mentions;

    const usernames = extractMentions(content);
    const users = await this.resolveUsers(usernames, manager);
    const targetUserIds = new Set(users.map((u) => u.id));

    const existing = await mentionRepo.find({ where: { commentId } });
    const existingIds = new Set(existing.map((m) => m.userId));

    const toAdd = [...targetUserIds].filter((id) => !existingIds.has(id));
    const toRemove = existing.filter((m) => !targetUserIds.has(m.userId));

    if (toAdd.length > 0) {
      const rows = toAdd.map((userId) =>
        mentionRepo.create({ commentId, userId }),
      );
      // D6a: save(entities). D32: CommentMention is in the AuditSubscriber
      // skip list — these saves do NOT produce audit rows. The parent
      // Comment's CREATE/UPDATE audit row carries the mention-diff intent
      // via its content snapshot.
      await mentionRepo.save(rows);
    }
    if (toRemove.length > 0) {
      // D6a: remove(entities). D32: also skipped by the subscriber.
      await mentionRepo.remove(toRemove);
    }
  }

  // For each comment in `rows`, attach its mentionedUsers list. One JOIN
  // pass to keep it O(comments) not O(comments * mentions).
  //
  // D25: accepts an optional `manager`. When passed, reads go through that
  // transaction's connection and see uncommitted writes from the same
  // transaction. When omitted, falls back to class-level repos for the
  // read-only listByTicket path.
  private async projectMentions(
    rows: Comment[],
    manager?: EntityManager,
  ): Promise<CommentResponse[]> {
    if (rows.length === 0) return [];
    const commentIds = rows.map((r) => r.id);

    const mentionRepo = manager
      ? manager.getRepository(CommentMention)
      : this.mentions;
    const userRepo = manager ? manager.getRepository(User) : this.users;

    const mentionRows = await mentionRepo
      .createQueryBuilder('m')
      .where('m.commentId IN (:...ids)', { ids: commentIds })
      .getMany();

    const userIds = Array.from(new Set(mentionRows.map((m) => m.userId)));
    const users = userIds.length
      ? await userRepo.find({
          where: userIds.map((id) => ({ id })),
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const byComment = new Map<number, MentionedUser[]>();
    for (const m of mentionRows) {
      const u = userById.get(m.userId);
      if (!u) continue;
      const list = byComment.get(m.commentId) ?? [];
      list.push({
        id: u.id,
        username: u.username,
        fullName: u.fullName,
      });
      byComment.set(m.commentId, list);
    }
    return rows.map((c) => ({
      ...toCommentResponse(c),
      mentionedUsers: byComment.get(c.id) ?? [],
    }));
  }
}
