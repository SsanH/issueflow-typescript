import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';

const BCRYPT_COST = 10;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.users.find();
  }

  async findById(id: number): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  // Used by AuthService — needs passwordHash, which is select:false by default.
  // D21: case-insensitive lookup so login works regardless of how the user
  // capitalized their username when registering.
  findByUsernameWithPassword(username: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('LOWER(u.username) = LOWER(:username)', { username })
      .getOne();
  }

  async create(dto: CreateUserDto): Promise<User> {
    // D21: uniqueness is case-insensitive — `Alice` and `alice` cannot both
    // register. Application-layer check gives a clean 409 error; the DB-layer
    // expression unique index (migration EnforceCaseInsensitiveUsernameEmail)
    // closes the concurrent-insert race.
    const existing = await this.users
      .createQueryBuilder('u')
      .where('LOWER(u.username) = LOWER(:username)', {
        username: dto.username,
      })
      .orWhere('LOWER(u.email) = LOWER(:email)', { email: dto.email })
      .getOne();
    if (existing) {
      throw new ConflictException(
        existing.username.toLowerCase() === dto.username.toLowerCase()
          ? 'Username already taken'
          : 'Email already registered',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const entity = this.users.create({
      username: dto.username,
      email: dto.email,
      fullName: dto.fullName,
      role: dto.role,
      passwordHash,
    });
    // D6a: save(entity) so AuditSubscriber fires.
    const saved = await this.users.save(entity);
    // Strip the hash before returning so the controller never even sees it.
    delete (saved as Partial<User>).passwordHash;
    return saved;
  }

  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findById(id);
    if (dto.fullName !== undefined) user.fullName = dto.fullName;
    if (dto.role !== undefined) user.role = dto.role;
    return this.users.save(user);
  }

  async remove(id: number): Promise<void> {
    const user = await this.findById(id);
    // D6a: remove(entity) so AuditSubscriber fires (afterRemove).
    // FK behavior: tickets.assigneeId ON DELETE SET NULL (configured on Ticket
    // in Phase 3); comments.authorId ON DELETE RESTRICT (RDBMS blocks the
    // delete if any comments reference this user — preserves authorship).
    await this.users.remove(user);
  }
}
