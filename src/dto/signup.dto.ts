import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export interface SignupDto {
  fullname: string;
  email: string;
  password: string;
}

@Injectable()
export class SignupValidationPipe implements PipeTransform<unknown, SignupDto> {
  transform(value: unknown): SignupDto {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('A signup form is required');
    }
    const { fullname, email, password } = value as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof fullname !== 'string' || !fullname.trim()) {
      errors.push('Full name is required');
    }
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.push('A valid email address is required');
    }
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      errors.push('Password must contain at least 8 characters and at most 72 UTF-8 bytes');
    }
    if (errors.length) throw new BadRequestException(errors);
    return {
      fullname: (fullname as string).trim(),
      email: (email as string).trim().toLowerCase(),
      password: password as string,
    };
  }
}
