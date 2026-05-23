import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll(): Promise<User[]> {
    return this.users.findAll();
  }

  @Get(':userId')
  findOne(@Param('userId', ParseIntPipe) userId: number): Promise<User> {
    return this.users.findById(userId);
  }

  // README contract uses 200 OK for create (not 201). Honor it.
  // @Public(): open registration. The README contract is silent on whether
  // POST /users requires auth; with the global JwtAuthGuard, gating it means
  // there's no way to bootstrap the first user. Open registration is the
  // simpler interpretation for a homework — documented in run.md as a
  // contract interpretation under §10 #31.
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.users.create(dto);
  }

  // D3: README literally specifies POST (not PATCH) for this route.
  @Post('update/:userId')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateUserDto,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- UsersService.update wraps repo.save(entity); subscriber fires
    await this.users.update(userId, dto);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('userId', ParseIntPipe) userId: number): Promise<void> {
    await this.users.remove(userId);
  }
}
