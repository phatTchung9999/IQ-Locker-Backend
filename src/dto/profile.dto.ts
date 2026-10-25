import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export interface ProfileDto {
    fullname: string;
    phone?: string;
    school?: string;
    major?: string;
}

@Injectable()
export class ProfileValidationPipe implements PipeTransform<unknown, ProfileDto> {
    transform(value: unknown): ProfileDto {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new BadRequestException('Profile information is required');
        }
        const input = value as Record<string, unknown>;
        if (typeof input.fullname !== 'string') throw new BadRequestException('Full name is required');
        const name = input.fullname.trim().replace(/\s+/g, ' ');
        if (!name || name.length > 100) {
            throw new BadRequestException('Full name must contain between 1 and 100 characters');
        }
        const profile: ProfileDto = { fullname: name };
        for (const [field, limit] of [['phone', 40], ['school', 150], ['major', 150]] as const) {
            if (input[field] === undefined) continue;
            if (typeof input[field] !== 'string') throw new BadRequestException(`${field} must be text`);
            const text = (input[field] as string).trim().replace(/\s+/g, ' ');
            if (text.length > limit) throw new BadRequestException(`${field} must contain at most ${limit} characters`);
            if (field === 'phone' && text && (!/^[+\d\s().#xX-]+$/.test(text) || !/\d/.test(text))) {
                throw new BadRequestException('Enter a valid phone number');
            }
            profile[field] = text;
        }
        return profile;
    }
}
