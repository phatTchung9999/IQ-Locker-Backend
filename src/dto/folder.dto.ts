import { BadRequestException } from '@nestjs/common';
export const materialTypes = ['', 'syllabus', 'lecture', 'quiz', 'exam', 'other'];
export function validateFolder(input: unknown, partial = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Folder information is required');
    const value = input as Record<string, unknown>;
    const fields: { name?: string; nameKey?: string; materialType?: string } = {};
    if (value.name !== undefined || !partial) {
        if (typeof value.name !== 'string') throw new BadRequestException('Folder name is required');
        const name = value.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
        if (!name || name.length > 120) throw new BadRequestException('Folder name must contain 1–120 characters');
        fields.name = name;
        fields.nameKey = name.toLowerCase();
    }
    if (value.materialType !== undefined) {
        if (typeof value.materialType !== 'string' || !materialTypes.includes(value.materialType)) throw new BadRequestException('Invalid material type');
        fields.materialType = value.materialType;
    }
    if (!Object.keys(fields).length) throw new BadRequestException('Provide a folder name or material type');
    return fields;
}
