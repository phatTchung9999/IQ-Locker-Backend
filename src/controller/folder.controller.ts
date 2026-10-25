import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { UserRequest } from '../app.middleware.js';
import { FolderService } from '../service/folder.service.js';
@Controller('/api/v1/courses/:courseId/folders')
export class FolderController {
    constructor(private readonly folders: FolderService) {}
    @Get() list(@Req() req: UserRequest, @Param('courseId') course: string, @Query('parent') parent?: string) { return this.folders.list(req.user._id, course, parent); }
    @Post() create(@Req() req: UserRequest, @Param('courseId') course: string, @Body() input: unknown) { return this.folders.create(req.user._id, course, input); }
    @Get('/:folderId') read(@Req() req: UserRequest, @Param('courseId') course: string, @Param('folderId') folder: string) { return this.folders.read(req.user._id, course, folder); }
    @Patch('/:folderId') update(@Req() req: UserRequest, @Param('courseId') course: string, @Param('folderId') folder: string, @Body() input: unknown) { return this.folders.update(req.user._id, course, folder, input); }
    @Delete('/:folderId') @HttpCode(204) async delete(@Req() req: UserRequest, @Param('courseId') course: string, @Param('folderId') folder: string) { await this.folders.delete(req.user._id, course, folder); }
}
