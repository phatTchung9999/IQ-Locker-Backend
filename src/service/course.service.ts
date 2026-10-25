import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Course } from '../model/course.schema.js';
import type { CourseDocument } from '../model/course.schema.js';
import { FolderService } from './folder.service.js';
import { validateCourse } from '../dto/course.dto.js';

function response(course: CourseDocument) {
    return {
        id: course._id.toString(), name: course.name, code: course.code ?? '',
        semester: course.semester ?? '', createdAt: course.createdAt, updatedAt: course.updatedAt,
    };
}

@Injectable()
export class CourseService {
    constructor(@InjectModel(Course.name) private readonly courses: Model<CourseDocument>, private readonly folders: FolderService) {}

    private owned(courseId: string, owner: Types.ObjectId) {
        if (!/^[a-f\d]{24}$/i.test(courseId)) throw new BadRequestException('Invalid course ID');
        return { _id: new Types.ObjectId(courseId), owner };
    }

    async create(owner: Types.ObjectId, input: unknown) {
        const fields = validateCourse(input);
        const course = await this.folders.createCourse(owner, fields);
        return response(course);
    }

    async list(owner: Types.ObjectId) {
        const courses = await this.courses.find({ owner }).sort({ createdAt: -1, _id: -1 }).exec();
        return courses.map(response);
    }

    async read(owner: Types.ObjectId, courseId: string) {
        const course = await this.courses.findOne(this.owned(courseId, owner)).exec();
        if (!course) throw new NotFoundException('Course not found');
        return response(course);
    }

    async update(owner: Types.ObjectId, courseId: string, input: unknown) {
        const filter = this.owned(courseId, owner);
        const fields = validateCourse(input, true);
        const course = await this.courses.findOneAndUpdate(filter, { $set: fields }, { new: true, runValidators: true }).exec();
        if (!course) throw new NotFoundException('Course not found');
        return response(course);
    }

    async delete(owner: Types.ObjectId, courseId: string) {
        await this.folders.deleteCourse(owner, courseId);
    }
}
