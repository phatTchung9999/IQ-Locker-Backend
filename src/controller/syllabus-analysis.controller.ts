import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { UserRequest } from '../app.middleware.js';
import { SyllabusAnalysisService } from '../service/syllabus-analysis.service.js';

@Controller('/api/v1/courses/:courseId/materials/:materialId/analysis')
export class SyllabusAnalysisController {
    constructor(private readonly analysis: SyllabusAnalysisService) {}

    @Post()
    @HttpCode(202)
    @Header('Cache-Control', 'private, no-store')
    start(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') material: string) {
        return this.analysis.start(req.user._id, course, material);
    }

    @Get()
    @Header('Cache-Control', 'private, no-store')
    status(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') material: string) {
        return this.analysis.status(req.user._id, course, material);
    }

    @Get('results')
    @Header('Cache-Control', 'private, no-store')
    results(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') material: string,
        @Query('extractionId') extractionId?: string) {
        return this.analysis.results(req.user._id, course, material, extractionId);
    }

    @Post('review')
    @HttpCode(200)
    @Header('Cache-Control', 'private, no-store')
    review(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') material: string, @Body() body: unknown) {
        return this.analysis.review(req.user._id, course, material, body);
    }

    @Post('retry')
    @HttpCode(202)
    @Header('Cache-Control', 'private, no-store')
    retry(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') material: string) {
        return this.analysis.retry(req.user._id, course, material);
    }
}

@Controller('/api/v1/deadlines')
export class DeadlineController {
    constructor(private readonly analysis: SyllabusAnalysisService) {}
    @Get('calendar')
    @Header('Cache-Control', 'private, no-store')
    calendar(@Req() req: UserRequest, @Query('materialId') materialId?: string) {
        return this.analysis.calendar(req.user._id, materialId);
    }
    @Get()
    @Header('Cache-Control', 'private, no-store')
    upcoming(@Req() req: UserRequest) { return this.analysis.upcoming(req.user._id); }
}
