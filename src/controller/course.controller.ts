import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { CourseService } from '../service/course.service.js';
import { CreateCoursePipe, UpdateCoursePipe } from '../dto/course.dto.js';
import type { CourseDto } from '../dto/course.dto.js';
import type { UserRequest } from '../app.middleware.js';

@Controller('/api/v1/courses')
export class CourseController {
    constructor(private readonly courses: CourseService) {}

    @Post()
    create(@Req() request: UserRequest, @Body(CreateCoursePipe) input: CourseDto) {
        return this.courses.create(request.user._id, input);
    }
    @Get()
    list(@Req() request: UserRequest) { return this.courses.list(request.user._id); }
    @Get('/:courseId')
    read(@Req() request: UserRequest, @Param('courseId') id: string) { return this.courses.read(request.user._id, id); }
    @Patch('/:courseId')
    update(@Req() request: UserRequest, @Param('courseId') id: string, @Body(UpdateCoursePipe) input: Partial<CourseDto>) {
        return this.courses.update(request.user._id, id, input);
    }
    @Delete('/:courseId')
    @HttpCode(204)
    async delete(@Req() request: UserRequest, @Param('courseId') id: string) { await this.courses.delete(request.user._id, id); }
}
