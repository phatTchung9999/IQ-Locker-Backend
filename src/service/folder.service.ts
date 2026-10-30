import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Course } from '../model/course.schema.js';
import type { CourseDocument } from '../model/course.schema.js';
import { Folder } from '../model/folder.schema.js';
import type { FolderDocument } from '../model/folder.schema.js';
import type { CourseDto } from '../dto/course.dto.js';
import { Material } from '../model/material.schema.js';
import type { MaterialDocument } from '../model/material.schema.js';
import { validateFolder } from '../dto/folder.dto.js';

const MAX_DEPTH = 10;
const presets = [ ['Syllabus', 'syllabus'], ['Lectures', 'lecture'], ['Quizzes', 'quiz'], ['Exams', 'exam'] ] as const;
function id(value: string, label: string) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException(`Invalid ${label} ID`);
    return new Types.ObjectId(value);
}
function starterOrder(folder: FolderDocument) {
    const index = presets.findIndex(([, key]) => key === folder.starterKey);
    return index < 0 ? presets.length : index;
}
function isStarter(folder: FolderDocument) { return starterOrder(folder) < presets.length; }
function response(folder: FolderDocument) {
    return { id: folder._id.toString(), name: folder.name, isStarter: isStarter(folder), materialType: folder.materialType ?? '',
        parent: folder.parent?.toString() ?? null, createdAt: folder.createdAt, updatedAt: folder.updatedAt };
}
@Injectable()
export class FolderService {
    constructor(@InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
        @InjectModel(Folder.name) private readonly folders: Model<FolderDocument>,
        @InjectModel(Material.name) private readonly materials: Model<MaterialDocument>) {}

    private async course(owner: Types.ObjectId, courseId: string) {
        const filter = { _id: id(courseId, 'course'), owner };
        if (!await this.courses.exists(filter)) throw new NotFoundException('Course not found');
        return { owner, course: filter._id };
    }

    // Every structural write touches the same course first. MongoDB retries write
    // conflicts, serializing parent deletion/child creation across server processes.
    // No nontransactional fallback: a standalone MongoDB must enable a replica set.
    private async transaction<T>(work: (session: ClientSession) => Promise<T>) {
        try { return await this.courses.db.transaction(work); }
        catch (error: any) {
            if (error.code === 11000) throw new ConflictException('A folder with this name already exists here');
            if (error.code === 20 || /Transaction numbers are only allowed|replica set/i.test(error.message ?? '')) {
                throw new ServiceUnavailableException('Course and folder changes require MongoDB running as a replica set. Please contact the administrator.');
            }
            throw error;
        }
    }

    async withCourse<T>(owner: Types.ObjectId, courseId: string, work: (scope: {owner: Types.ObjectId; course: Types.ObjectId}, session: ClientSession) => Promise<T>) {
        const course = id(courseId, 'course');
        return this.transaction(async (session) => {
            const locked = await this.courses.findOneAndUpdate({ _id: course, owner }, { $inc: { treeRevision: 1 } }, { session, returnDocument: 'after' });
            if (!locked) throw new NotFoundException('Course not found');
            return work({ owner, course }, session);
        });
    }

    // The course and its initial folders commit together, or none are created.
    async createCourse(owner: Types.ObjectId, fields: Partial<CourseDto>) {
        return this.transaction(async (session) => {
            const [course] = await this.courses.create([{ ...fields, owner }], { session });
            for (const [name, materialType] of presets) {
                await this.folders.create([{ owner, course: course._id, parent: null,
                    name, nameKey: name.toLowerCase(), materialType, starterKey: materialType }], { session });
            }
            return course;
        });
    }

    private async ancestry(scope: {owner: Types.ObjectId; course: Types.ObjectId}, folderId: string | null, session?: ClientSession) {
        const ancestors: FolderDocument[] = [];
        const seen = new Set<string>();
        let next = folderId;
        while (next) {
            if (seen.has(next) || ancestors.length >= MAX_DEPTH) throw new ConflictException('Invalid folder hierarchy');
            seen.add(next);
            const folder = await this.folders.findOne({ ...scope, _id: id(next, 'folder') }).session(session ?? null);
            if (!folder) throw new NotFoundException('Folder not found');
            ancestors.unshift(folder);
            next = folder.parent?.toString() ?? null;
        }
        return ancestors;
    }

    async location(owner: Types.ObjectId, courseId: string, folderId: string | null) {
        const scope = await this.course(owner, courseId);
        if (folderId !== null && (typeof folderId !== 'string' || !folderId)) throw new BadRequestException('Invalid folder ID');
        await this.ancestry(scope, folderId);
        return scope;
    }

    async destination(owner: Types.ObjectId, course: Types.ObjectId, folder: string | null, session: ClientSession) {
        const ancestors = await this.ancestry({ owner, course }, folder, session);
        return [...ancestors].reverse().find((item) => item.materialType)?.materialType ?? '';
    }

    async list(owner: Types.ObjectId, courseId: string, parent?: string) {
        if (parent !== undefined) id(parent, 'parent');
        const scope = await this.course(owner, courseId);
        const ancestors = await this.ancestry(scope, parent ?? null);
        const folders = await this.folders.find({ ...scope, parent: parent ? id(parent, 'parent') : null }).sort({ nameKey: 1, _id: 1 });
        return { folders: folders.sort((a, b) => starterOrder(a) - starterOrder(b)).map(response), breadcrumbs: ancestors.map(response) };
    }
    async read(owner: Types.ObjectId, courseId: string, folderId: string) {
        id(folderId, 'folder');
        const scope = await this.course(owner, courseId);
        const ancestors = await this.ancestry(scope, folderId);
        return { ...response(ancestors[ancestors.length - 1]), breadcrumbs: ancestors.map(response) };
    }
    async create(owner: Types.ObjectId, courseId: string, input: unknown) {
        const fields = validateFolder(input);
        const parent = (input as Record<string, unknown>).parent;
        if (parent !== undefined && parent !== null && typeof parent !== 'string') throw new BadRequestException('Invalid parent ID');
        if (parent === '') throw new BadRequestException('Invalid parent ID');
        return this.withCourse(owner, courseId, async (scope, session) => {
            const ancestors = await this.ancestry(scope, (parent as string | null | undefined) ?? null, session);
            if (ancestors.length >= MAX_DEPTH) throw new BadRequestException('Folders can be nested up to 10 levels');
            const [folder] = await this.folders.create([{ ...fields, ...scope, parent: parent ? id(parent as string, 'parent') : null }], { session });
            return response(folder);
        });
    }
    async update(owner: Types.ObjectId, courseId: string, folderId: string, input: unknown) {
        if (input && typeof input === 'object' && 'parent' in input) throw new BadRequestException('Moving folders is not supported');
        const fields = validateFolder(input, true);
        id(folderId, 'folder');
        return this.withCourse(owner, courseId, async (scope, session) => {
            const ancestors = await this.ancestry(scope, folderId, session);
            if (fields.name !== undefined && isStarter(ancestors[ancestors.length - 1])) {
                throw new ForbiddenException('Starter folders cannot be renamed');
            }
            const folder = await this.folders.findOneAndUpdate({ ...scope, _id: id(folderId, 'folder') }, { $set: fields }, { returnDocument: 'after', runValidators: true, session });
            if (!folder) throw new NotFoundException('Folder not found');
            return response(folder);
        });
    }
    async delete(owner: Types.ObjectId, courseId: string, folderId: string) {
        id(folderId, 'folder');
        return this.withCourse(owner, courseId, async (scope, session) => {
            const ancestors = await this.ancestry(scope, folderId, session);
            const folder = ancestors[ancestors.length - 1];
            if (isStarter(folder)) throw new ForbiddenException('Starter folders cannot be deleted');
            if (await this.materials.exists({ ...scope, folder: folder._id }).session(session)) throw new ConflictException('Remove documents before deleting this folder');
            if (await this.folders.exists({ ...scope, parent: folder._id }).session(session)) throw new ConflictException('Only empty folders can be deleted');
            await this.folders.deleteOne({ ...scope, _id: folder._id }, { session });
        });
    }
    async deleteCourse(owner: Types.ObjectId, courseId: string) {
        return this.withCourse(owner, courseId, async (scope, session) => {
            if (await this.materials.exists(scope).session(session)) throw new ConflictException('Remove documents and wait for pending uploads or cleanup before deleting this course');
            const contained = await this.folders.find(scope).session(session);
            if (contained.some((folder) => folder.parent || !isStarter(folder))) {
                throw new ConflictException('Remove custom folders and contents before deleting this course. Empty starter folders are removed automatically.');
            }
            for (const folder of contained) await this.folders.deleteOne({ ...scope, _id: folder._id }, { session });
            await this.courses.deleteOne({ _id: scope.course, owner }, { session });
        });
    }
}
