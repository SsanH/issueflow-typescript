import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CommentResponse } from './comment-response';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

@Controller('tickets/:ticketId/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<CommentResponse[]> {
    return this.comments.listByTicket(ticketId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  create(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CommentResponse> {
    // D26: pass full requester (id + role) so the service can gate edit/
    // delete on authorship-or-ADMIN. Create doesn't need the gate, but
    // the same requester shape is threaded through for symmetry.
    return this.comments.create(ticketId, dto, {
      id: user.id,
      role: user.role,
    });
  }

  @Patch(':commentId')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() dto: UpdateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- service.update wraps repo.save inside a transaction; subscriber fires
    await this.comments.update(ticketId, commentId, dto, {
      id: user.id,
      role: user.role,
    });
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.comments.remove(ticketId, commentId, {
      id: user.id,
      role: user.role,
    });
  }
}
