import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export interface CourseDto { name: string; code?: string; semester?: string; }

export function validateCourse(input: unknown, partial = false): Partial<CourseDto> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new BadRequestException('Course information is required');
    }
    const value = input as Record<string, unknown>;
    const result: Partial<CourseDto> = {};
    for (const [field, limit] of [['name', 120], ['code', 40], ['semester', 80]] as const) {
        if (value[field] === undefined) {
            if (field === 'name' && !partial) throw new BadRequestException('Course name is required');
            continue;
        }
        if (typeof value[field] !== 'string') throw new BadRequestException(`${field} must be text`);
        const text = (value[field] as string).trim().replace(/\s+/g, ' ');
        if (field === 'name' && !text) throw new BadRequestException('Course name is required');
        if (text.length > limit) throw new BadRequestException(`${field} must contain at most ${limit} characters`);
        result[field] = text;
    }
    if (!Object.keys(result).length) throw new BadRequestException('Provide a course name, code, or semester to update');
    return result;
}

@Injectable()
export class CreateCoursePipe implements PipeTransform<unknown, CourseDto> {
    transform(value: unknown): CourseDto { return validateCourse(value) as CourseDto; }
}

@Injectable()
export class UpdateCoursePipe implements PipeTransform<unknown, Partial<CourseDto>> {
    transform(value: unknown): Partial<CourseDto> { return validateCourse(value, true); }
}
