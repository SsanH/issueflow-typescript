import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TicketsModule } from '../tickets/tickets.module';
import { User } from '../users/user.entity';
import { Comment } from './comment.entity';
import { CommentMention } from './comment-mention.entity';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { MentionsController } from './mentions.controller';
import { MentionsService } from './mentions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Comment, CommentMention, User]),
    TicketsModule,
  ],
  controllers: [CommentsController, MentionsController],
  providers: [CommentsService, MentionsService],
  exports: [CommentsService, MentionsService],
})
export class CommentsModule {}
